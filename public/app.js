const $ = (id) => document.getElementById(id);

const PROVIDERS = {
  claude: { label: "Claude Code", color: "#d97757" },
  codex: { label: "Codex", color: "var(--contrast-foreground)" },
  grok: { label: "Grok Build", color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))" },
  cursor: { label: "Cursor", color: "#8b8b8b" },
  opencode: { label: "OpenCode", color: "#5b9bbd" },
  antigravity: { label: "Antigravity", color: "#8c7bd1" },
  pi: { label: "Pi", color: "#4d9f8a" },
  muse: { label: "Muse Code", color: "#0866ff" },
  zai: { label: "Z.ai / GLM", color: "#3fa37a" },
  kimi: { label: "Kimi Code", color: "#c9a13b" },
};
const providerLabel = (provider) => PROVIDERS[provider]?.label ?? provider ?? "Unknown";
const providerColor = (provider) => PROVIDERS[provider]?.color ?? "var(--muted-foreground)";
const ink = (percent) => `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
const TYPE_COLORS = { input: ink(60), cacheRead: ink(30), cacheWrite: ink(72), output: ink(100) };

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const countFmt = new Intl.NumberFormat();
const formatUsd = (value) => usd.format(value ?? 0);
const formatTokens = (value) => compactFmt.format(value ?? 0);
const formatCount = (value) => countFmt.format(Math.round(value ?? 0));
const formatPercent = (share) => {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const plural = (count, one, other) => `${formatCount(count)} ${count === 1 ? one : other}`;

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const dayShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const hourShort = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function readPreference(key, fallback, valid) {
  try {
    const value = localStorage.getItem(`usage.${key}`);
    return value !== null && valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function writePreference(key, value) {
  try { localStorage.setItem(`usage.${key}`, value); } catch { /* storage unavailable */ }
}

const state = {
  days: Number(readPreference("days", "7", (v) => ["1", "7", "30", "90"].includes(v))),
  metric: readPreference("metric", "cost", (v) => ["cost", "tokens", "limits"].includes(v)),
  breakdown: "model",
  data: null,
  loading: false,
  requestId: 0,
  editingRenewal: null,
  savingRenewal: false,
};

function windowBounds(days = state.days) {
  const until = Date.now();
  if (days === 1) return { since: until - 86400000, until };
  const start = new Date(until);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return { since: start.getTime(), until };
}

function periodsFor(meta) {
  const hourly = meta.untilMs - meta.sinceMs <= 36 * 3600000;
  if (hourly) {
    const periods = [];
    for (let hour = Math.floor(meta.sinceMs / 3600000); hour <= Math.floor((meta.untilMs - 1) / 3600000); hour++) {
      periods.push(new Date(hour * 3600000).toISOString());
    }
    return { hourly, periods };
  }
  const periods = [];
  for (let at = meta.sinceMs + 12 * 3600000; ; at += 86400000) {
    const key = dayKey.format(new Date(Math.min(at, meta.untilMs)));
    if (periods.at(-1) !== key) periods.push(key);
    if (at >= meta.untilMs) break;
  }
  return { hourly, periods };
}
const formatPeriod = (period, hourly) =>
  hourly ? hourShort.format(new Date(period)) : dayShort.format(new Date(`${period}T12:00:00`));

// Each period's response is reused for a minute, and the other periods are fetched in the
// background after the first load, so switching periods renders without waiting on the server.
const periodCache = new Map();
const PERIOD_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 25000;
let cacheEpoch = 0;
let limitsVersion = 0;
let renewalSaveId = 0;
let lastLimitsAt = 0;
let foregroundController = null;
let prefetchController = null;
let backgroundLimitsController = null;

function setLoading(loading) {
  state.loading = loading;
  document.body.classList.toggle("loading", loading);
  syncControls();
}

async function fetchJsonWithTimeout(url, parentSignal, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not read usage.");
    return body;
  } catch (error) {
    if (timedOut) throw new Error("Request timed out. Click refresh to try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function fetchPeriod(days, { force = false, signal, epoch = cacheEpoch } = {}) {
  const startedAt = Date.now();
  const startedLimitsVersion = limitsVersion;
  const query = new URLSearchParams({ ...windowBounds(days), timeZone });
  if (force) query.set("refresh", "1");
  const raw = await fetchJsonWithTimeout(`/api/dashboard?${query}`, signal);
  // Never let an older in-flight dashboard response revert a newer renewal save.
  const body = startedLimitsVersion !== limitsVersion && state.data?.limits
    ? { ...raw, limits: state.data.limits }
    : raw;
  if (epoch === cacheEpoch) {
    const held = periodCache.get(days);
    if (!held || held.startedAt <= startedAt) periodCache.set(days, { data: body, at: Date.now(), startedAt });
    if (startedLimitsVersion === limitsVersion) lastLimitsAt = Math.max(lastLimitsAt, Date.now());
  }
  return body;
}

async function prefetchOtherPeriods() {
  if (state.metric === "limits") return;
  prefetchController?.abort();
  const controller = new AbortController();
  prefetchController = controller;
  const epoch = cacheEpoch;
  try {
    for (const days of [1, 7, 30, 90]) {
      if (controller.signal.aborted || epoch !== cacheEpoch) return;
      const held = periodCache.get(days);
      if (held && Date.now() - held.at < PERIOD_TTL_MS) continue;
      try {
        await fetchPeriod(days, { signal: controller.signal, epoch });
      } catch {
        if (controller.signal.aborted) return;
        // Otherwise the period loads on demand.
      }
    }
  } finally {
    if (prefetchController === controller) prefetchController = null;
  }
}

function applyLimits(limits, { updateTimestamp = true } = {}) {
  if (!state.data) return;
  state.data = { ...state.data, limits };
  for (const [days, held] of periodCache) {
    periodCache.set(days, { ...held, data: { ...held.data, limits } });
  }
  if (updateTimestamp) lastLimitsAt = Date.now();
  if (state.metric === "limits") renderNotices();
  renderLimits();
}

async function refreshLimits({ force = true, showLoading = true } = {}) {
  if (!state.data) return load(force);
  const startedLimitsVersion = limitsVersion;
  if (showLoading) {
    const requestId = ++state.requestId;
    foregroundController?.abort();
    backgroundLimitsController?.abort();
    prefetchController?.abort();
    const controller = new AbortController();
    foregroundController = controller;
    setLoading(true);
    try {
      const body = await fetchJsonWithTimeout(`/api/limits${force ? "?refresh=1" : ""}`, controller.signal);
      if (requestId !== state.requestId || startedLimitsVersion !== limitsVersion) return;
      applyLimits(body.limits);
    } catch (error) {
      if (requestId !== state.requestId || controller.signal.aborted) return;
      $("notices").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
    } finally {
      if (requestId === state.requestId) {
        foregroundController = null;
        setLoading(false);
      }
    }
    return;
  }
  if (state.loading) return;
  backgroundLimitsController?.abort();
  const controller = new AbortController();
  backgroundLimitsController = controller;
  const requestId = state.requestId;
  try {
    const body = await fetchJsonWithTimeout(`/api/limits${force ? "?refresh=1" : ""}`, controller.signal);
    if (controller.signal.aborted || requestId !== state.requestId || startedLimitsVersion !== limitsVersion) return;
    applyLimits(body.limits);
  } catch {
    // Silent background poll; manual refresh surfaces errors.
  } finally {
    if (backgroundLimitsController === controller) backgroundLimitsController = null;
  }
}

async function load(force = false) {
  const requestId = ++state.requestId;
  const days = state.days;
  foregroundController?.abort();
  prefetchController?.abort();
  if (force) {
    backgroundLimitsController?.abort();
    cacheEpoch += 1;
    periodCache.clear();
  }
  const held = periodCache.get(days);
  if (held) {
    state.data = held.data;
    if (Date.now() - held.at < PERIOD_TTL_MS) {
      foregroundController = null;
      setLoading(false);
      render();
      prefetchOtherPeriods();
      return;
    }
    render();
  }
  const controller = new AbortController();
  foregroundController = controller;
  const epoch = cacheEpoch;
  setLoading(true);
  try {
    const body = await fetchPeriod(days, { force, signal: controller.signal, epoch });
    if (requestId !== state.requestId) return;
    state.data = body;
    render();
    prefetchOtherPeriods();
  } catch (error) {
    if (requestId !== state.requestId || controller.signal.aborted) return;
    $("notices").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  } finally {
    if (requestId === state.requestId) {
      foregroundController = null;
      setLoading(false);
    }
  }
}

function syncControls() {
  for (const button of document.querySelectorAll("[data-days]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.days) === state.days));
  }
  for (const button of document.querySelectorAll("[data-metric]")) {
    button.setAttribute("aria-pressed", String(button.dataset.metric === state.metric));
  }
  const limits = state.metric === "limits";
  $("periodGroup").hidden = limits;
  $("windowLabel").hidden = limits;
  $("crumbTitle").textContent = limits ? "Limits" : "Usage";
  $("usageView").hidden = limits;
  $("limitsView").hidden = !limits;
  $("refresh").setAttribute("aria-busy", String(state.loading));
  $("refresh").disabled = state.loading;
  $("refresh").setAttribute("aria-label", limits ? "Refresh limits" : "Refresh usage");
}

function renderNotices() {
  const data = state.data;
  if (!data) return;
  const problems = data.sources.filter((source) => source.status !== "ok" && source.message);
  $("notices").innerHTML = problems.map((source) => `<p class="notice">${escapeHtml(source.label)}: ${escapeHtml(source.message)}</p>`).join("");
}

function render() {
  const data = state.data;
  if (!data) return;
  const { meta } = data;
  $("windowLabel").textContent = `${dateTime.format(new Date(meta.sinceMs))} – ${dateTime.format(new Date(meta.untilMs))}`;
  renderNotices();
  renderUsage();
  renderLimits();
}

/* ---------- Usage ---------- */

function renderUsage() {
  const data = state.data;
  const metric = state.metric === "tokens" ? "tokens" : "cost";
  const value = (row) => (metric === "tokens" ? row.totalTokens : row.costUsd);
  const summary = data.summary;
  const providers = data.providers.filter((row) => row.totalTokens > 0 || row.costUsd > 0).sort((a, b) => value(b) - value(a));
  const totalCost = providers.reduce((sum, row) => sum + row.costUsd, 0);
  const totalTokens = providers.reduce((sum, row) => sum + row.totalTokens, 0);
  const unpricedShare = summary.totalTokens > 0 ? summary.unpricedTokens / summary.totalTokens : 0;
  const { hourly, periods } = periodsFor(data.meta);

  const providerRows = providers.map((row) => {
    const share = metric === "cost" ? (totalCost > 0 ? row.costUsd / totalCost : 0) : (totalTokens > 0 ? row.totalTokens / totalTokens : 0);
    const sub = metric === "cost"
      ? `${formatPercent(share)} of cost · ${formatTokens(row.totalTokens)} tokens`
      : `${formatPercent(share)} of tokens · ${formatUsd(row.costUsd)}`;
    return `<div class="provider">
      <dl>
        <dt><span class="dot" style="background:${providerColor(row.provider)}"></span>
          <span class="truncate">${escapeHtml(providerLabel(row.provider))}</span>
          <span class="sessions figure">${plural(row.sessions, "session", "sessions")}</span></dt>
        <dd class="figure">${metric === "cost" ? (row.costSource === "unpriced" ? '<span class="muted">Unpriced</span>' : formatUsd(row.costUsd)) : formatTokens(row.totalTokens)}</dd>
      </dl>
      <p class="provider-sub figure">${sub}</p>
    </div>`;
  }).join("");

  const unpricedInfo = metric === "cost" && unpricedShare > 0
    ? `<span class="info" data-tip="API estimate excludes ${escapeHtml(formatPercent(unpricedShare))} unpriced tokens.">${infoIcon}</span>`
    : "";

  const chartTitle = hourly ? (metric === "tokens" ? "Hourly processed tokens" : "Hourly cost") : (metric === "tokens" ? "Daily processed tokens" : "Daily cost");
  const totals = summary.totals;
  const shares = metric === "tokens"
    ? shareBar("Tokens by type", [
        ["Input", totals.uncachedInputTokens, TYPE_COLORS.input],
        ["Cache read", totals.cachedInputTokens, TYPE_COLORS.cacheRead],
        ["Cache write", totals.cacheCreationTokens, TYPE_COLORS.cacheWrite],
        ["Output", totals.outputTokens, TYPE_COLORS.output],
      ], formatTokens)
    : shareBar("Cost by type", [
        ["Input", summary.categoryCostUsd.input, TYPE_COLORS.input],
        ["Cache read", summary.categoryCostUsd.cacheRead, TYPE_COLORS.cacheRead],
        ["Cache write", summary.categoryCostUsd.cacheWrite, TYPE_COLORS.cacheWrite],
        ["Output", summary.categoryCostUsd.output, TYPE_COLORS.output],
      ], formatUsd);

  $("usageView").innerHTML = `
    <section class="overview">
      <div class="overview-left">
        <div class="headline">
          <p class="headline-value figure">${metric === "cost" ? formatUsd(summary.costUsd) : formatTokens(summary.totalTokens)}</p>
          <p class="headline-sub"><span><span class="figure">${plural(summary.sessions, "session", "sessions")}</span>${metric === "cost" ? " · API estimate" : ""}</span>${unpricedInfo}</p>
        </div>
        ${providerRows || '<p class="muted">No activity in this window.</p>'}
      </div>
      <div class="chart-col">
        <h2>${chartTitle}</h2>
        <div id="chart"></div>
      </div>
    </section>

    <section class="section">
      <h2>Totals</h2>
      <dl class="metrics">
        ${metricCell("Processed tokens", formatTokens(summary.totalTokens))}
        ${metricCell("Cached input", formatTokens(totals.cachedInputTokens))}
        ${metricCell("Uncached input", formatTokens(totals.uncachedInputTokens))}
        ${metricCell("Output", formatTokens(totals.outputTokens))}
        ${metricCell("Cache savings", formatUsd(summary.cacheSavingsUsd))}
      </dl>
    </section>

    ${summary.totalTokens > 0 ? `<section class="shares figure">${shares}</section>` : ""}

    <section class="section section-gap-3">
      <div class="section-head">
        <h2>Breakdown</h2>
        <div class="segmented" role="group" aria-label="Usage breakdown">
          <button type="button" data-breakdown="model" aria-pressed="${state.breakdown === "model"}">Model</button>
          <button type="button" data-breakdown="time" aria-pressed="${state.breakdown === "time"}">${hourly ? "Hour" : "Day"}</button>
        </div>
      </div>
      <div class="table-wrap">${state.breakdown === "model" ? modelTable(metric) : timeTable(providers, periods, hourly)}</div>
    </section>

    ${footnote()}
  `;
  renderChart(providers.map((row) => row.provider), periods, hourly, metric);
}

const metricCell = (label, value) => `<div class="metric"><dt>${label}</dt><dd class="figure">${value}</dd></div>`;

function shareBar(label, segments, format) {
  const visible = segments.filter(([, value]) => value > 0);
  const total = visible.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return "";
  return `<div class="share">
    <h3>${label}</h3>
    <div class="share-bar" aria-hidden="true">${visible.map(([name, value, color]) =>
      `<div style="flex:${value} 1 0;background:${color}" data-tip="${escapeHtml(`${name} · ${format(value)} · ${formatPercent(value / total)}`)}"></div>`).join("")}</div>
    <ul class="share-legend" aria-label="${label}">${visible.map(([name, value, color]) =>
      `<li><span class="swatch" style="background:${color}"></span><span class="muted">${name}</span> <span class="tabular">${format(value)}</span></li>`).join("")}</ul>
  </div>`;
}

function modelTable(metric) {
  const models = [...state.data.models].sort((a, b) => (metric === "tokens" ? b.totalTokens - a.totalTokens : b.costUsd - a.costUsd || b.totalTokens - a.totalTokens));
  const field = (model) => (metric === "tokens" ? model.totalTokens : model.costUsd);
  const peak = models.reduce((max, model) => Math.max(max, field(model)), 0);
  const total = models.reduce((sum, model) => sum + field(model), 0);
  const rows = models.map((model, index) => {
    const v = field(model);
    const bar = v > 0 && peak > 0
      ? `<div class="mini-bar figure"><div style="width:max(0.5rem, ${(v / peak) * 100}%);background:${providerColor(model.provider)}"></div></div>`
      : "";
    const unpriced = model.costSource === "unpriced" && model.totalTokens > 0;
    return `<tr>
      <td style="font-size:12px">${index + 1}</td>
      <td class="left wrap" style="width:100%"><div class="model-cell"><span class="dot" style="background:${providerColor(model.provider)}" title="${escapeHtml(providerLabel(model.provider))}"></span>${escapeHtml(model.model)}</div>${bar}</td>
      <td class="fg figure">${unpriced ? '<span class="muted">Unpriced</span>' : formatUsd(model.costUsd)}</td>
      <td class="hide-sm figure">${total > 0 && !(metric === "cost" && unpriced) ? formatPercent(v / total) : ""}</td>
      <td class="figure">${formatTokens(model.totalTokens)}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>#</th><th class="left" style="width:100%">Model</th><th>Cost</th><th class="hide-sm">Share</th><th>Tokens</th></tr></thead>
    <tbody>${rows || '<tr class="empty-row"><td colspan="5">No activity in this window.</td></tr>'}</tbody>
  </table>`;
}

function timeTable(providers, periods, hourly) {
  const byPeriod = new Map();
  for (const point of state.data.trend) {
    const entry = byPeriod.get(point.bucket) ?? { cost: 0, tokens: 0, byProvider: new Map() };
    entry.cost += point.costUsd;
    entry.tokens += point.tokens;
    entry.byProvider.set(point.provider, point.costUsd);
    byPeriod.set(point.bucket, entry);
  }
  const list = periods.filter((period) => byPeriod.has(period)).reverse();
  const rows = list.map((period) => {
    const entry = byPeriod.get(period);
    return `<tr>
      <td class="fg">${formatPeriod(period, hourly)}</td>
      ${providers.map((row) => `<td class="figure">${formatUsd(entry.byProvider.get(row.provider) ?? 0)}</td>`).join("")}
      <td class="fg figure">${formatUsd(entry.cost)}</td>
      <td class="figure">${formatTokens(entry.tokens)}</td>
    </tr>`;
  }).join("");
  return `<table>
    <colgroup><col style="width:40%"></colgroup>
    <thead><tr><th>${hourly ? "Hour" : "Day"}</th>${providers.map((row) => `<th>${escapeHtml(providerLabel(row.provider))}</th>`).join("")}<th>Total</th><th>Tokens</th></tr></thead>
    <tbody>${rows || `<tr class="empty-row"><td colspan="${providers.length + 3}">No activity in this window.</td></tr>`}</tbody>
  </table>`;
}

function footnote() {
  const { sources, meta } = state.data;
  const parts = sources.map((source) => {
    const size = source.files !== undefined ? plural(source.files, "file", "files") : plural(source.records ?? 0, "record", "records");
    const status = source.status === "ok" ? "" : ` <span class="src-error">(${escapeHtml(source.status)})</span>`;
    return `${escapeHtml(source.label)} · ${size}${status}`;
  });
  const pricing = meta.pricingFetchedAt ? `Prices from T3's rate table, fetched ${dateTime.format(new Date(meta.pricingFetchedAt))}. Kimi Code is priced at Moonshot API rates.` : "No cached rate table found.";
  return `<div class="footnote"><span>Sources: ${parts.join(" &nbsp;·&nbsp; ")}</span><span>${pricing} Costs are API estimates, not your subscription bill.</span></div>`;
}

/* ---------- Chart (layered monotone lines, as in T3's UsageProviderChart) ---------- */

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_TOP = 8;
const TICK_COUNT = 4;

function niceScale(peak) {
  if (peak <= 0) return { max: TICK_COUNT, ticks: [0, 1, 2, 3, 4] };
  const raw = peak / TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * magnitude).find((n) => n >= raw);
  return { max: step * TICK_COUNT, ticks: Array.from({ length: TICK_COUNT + 1 }, (_, i) => i * step) };
}

function monotonePath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  const n = points.length;
  const slopes = [];
  for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x));
  const tangents = [slopes[0]];
  for (let i = 1; i < n - 1; i++) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  tangents.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); tangents[i] = t * a * slopes[i]; tangents[i + 1] = t * b * slopes[i]; }
  }
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p = points[i], q = points[i + 1], dx = (q.x - p.x) / 3;
    path += ` C${(p.x + dx).toFixed(2)},${(p.y + tangents[i] * dx).toFixed(2)} ${(q.x - dx).toFixed(2)},${(q.y - tangents[i + 1] * dx).toFixed(2)} ${q.x.toFixed(2)},${q.y.toFixed(2)}`;
  }
  return path;
}

function renderChart(providers, periods, hourly, metric) {
  const host = $("chart");
  const byKey = new Map(state.data.trend.map((point) => [`${point.bucket}\0${point.provider}`, point]));
  const valueAt = (period, provider) => {
    const point = byKey.get(`${period}\0${provider}`);
    return point ? (metric === "tokens" ? point.tokens : point.costUsd) : 0;
  };
  if (providers.length === 0 || periods.length === 0) {
    host.innerHTML = '<div class="chart-empty">No activity in this window.</div>';
    return;
  }
  const peak = Math.max(0, ...periods.flatMap((period) => providers.map((provider) => valueAt(period, provider))));
  const scale = niceScale(peak);
  const toY = (value) => VIEW_HEIGHT - (value / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
  const stepX = periods.length > 1 ? VIEW_WIDTH / (periods.length - 1) : 0;
  const toX = (index) => (periods.length > 1 ? index * stepX : VIEW_WIDTH / 2);
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const axisFormat = metric === "tokens" ? formatTokens : (value) => (value >= 10 ? usdWhole.format(value) : formatUsd(value));

  const grid = scale.ticks.map((tick) => `<line x1="0" x2="${VIEW_WIDTH}" y1="${toY(tick)}" y2="${toY(tick)}" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");
  const series = providers.map((provider) => {
    const points = periods.map((period, index) => ({ x: toX(index), y: toY(valueAt(period, provider)) }));
    const line = monotonePath(points);
    const area = `${line} L${points.at(-1).x.toFixed(2)},${VIEW_HEIGHT} L${points[0].x.toFixed(2)},${VIEW_HEIGHT} Z`;
    return { provider, line, area };
  });
  const areas = series.map((s) => `<path d="${s.area}" fill="${providerColor(s.provider)}" fill-opacity="0.12"/>`).join("");
  const lines = series.map((s) => `<path d="${s.line}" fill="none" stroke="${providerColor(s.provider)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join("");
  const yLabels = scale.ticks.map((tick) => `<span style="top:${(toY(tick) / VIEW_HEIGHT) * 100}%">${tick === 0 ? "0" : escapeHtml(axisFormat(tick))}</span>`).join("");
  const mid = periods[Math.floor(periods.length / 2)];

  host.innerHTML = `<div class="chart">
    <div class="chart-row">
      <div class="y-axis" aria-hidden="true">${yLabels}</div>
      <div class="plot" role="img" aria-label="${escapeHtml(`${hourly ? "Hourly" : "Daily"} ${metric === "tokens" ? "tokens" : "cost"} by provider`)}">
        <svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" preserveAspectRatio="none">
          ${grid}${areas}${lines}
          <line id="guide" x1="0" x2="0" y1="${PLOT_TOP}" y2="${VIEW_HEIGHT}" stroke="var(--muted-foreground)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" visibility="hidden"/>
        </svg>
      </div>
    </div>
    <div class="x-axis" aria-hidden="true"><span>${formatPeriod(periods[0], hourly)}</span><span>${formatPeriod(mid, hourly)}</span><span>${formatPeriod(periods.at(-1), hourly)}</span></div>
  </div>`;

  const plot = host.querySelector(".plot");
  const guide = host.querySelector("#guide");
  plot.addEventListener("pointermove", (event) => {
    const bounds = plot.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const index = periods.length > 1 ? Math.round(ratio * (periods.length - 1)) : 0;
    const period = periods[index];
    const x = toX(index);
    guide.setAttribute("x1", x);
    guide.setAttribute("x2", x);
    guide.setAttribute("visibility", "visible");
    const values = providers.map((provider) => [provider, valueAt(period, provider)]).sort((a, b) => b[1] - a[1]);
    const total = values.reduce((sum, [, v]) => sum + v, 0);
    showTooltip(`<div class="tt-title">${escapeHtml(formatPeriod(period, hourly))}</div>
      ${values.map(([provider, v]) => `<div class="tt-row"><span><span class="dot" style="background:${providerColor(provider)}"></span>${escapeHtml(providerLabel(provider))}</span><span class="tt-value">${escapeHtml(format(v))}</span></div>`).join("")}
      <div class="tt-row tt-total"><span>Total</span><span class="tt-value">${escapeHtml(format(total))}</span></div>`,
      bounds.left + (x / VIEW_WIDTH) * bounds.width, bounds.top);
  });
  plot.addEventListener("pointerleave", () => {
    guide.setAttribute("visibility", "hidden");
    hideTooltip();
  });
}

/* ---------- Limits (mirrors T3's LimitWindows: % left, pace mark, resets in) ---------- */

const PACE = {
  over: { label: "Over pace: at this rate you'll run out before the window resets", icon: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>' },
  on: { label: "On pace with the window", icon: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>' },
  under: { label: "Under pace: headroom left for the rest of the window", icon: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>' },
};

function windowTiming(window, now) {
  if (!window.resetsAt || !window.windowDurationMins) return null;
  const durationMs = window.windowDurationMins * 60000;
  const left = Date.parse(window.resetsAt) - now;
  if (!Number.isFinite(left)) return null;
  return Math.min(100, Math.max(0, Math.round((left / durationMs) * 100)));
}

function paceOf(window, timeLeft) {
  if (timeLeft === null) return null;
  const elapsed = 100 - timeLeft;
  if (elapsed < 2) return null;
  if (window.usedPercent > elapsed + 5) return "over";
  if (window.usedPercent < elapsed - 5) return "under";
  return "on";
}

function resetsIn(window, now) {
  if (!window.resetsAt) return null;
  const ms = Date.parse(window.resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

function ago(iso, now) {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return dateTime.format(new Date(iso));
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const CADENCE_LABELS = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", none: "Ends" };
const dateMedium = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function renewalDetails(renewal, now) {
  if (!renewal) return null;
  const nowDate = new Date(now);
  const todayMid = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  let sortMs = Infinity;
  let dateLabel = "";
  let fullDate = "";
  let daysLeft = null;
  let countdown = "";
  let inputDate = "";

  if (renewal.date) {
    const [y, m, d] = renewal.date.split("-").map(Number);
    const localMid = new Date(y, m - 1, d).getTime();
    sortMs = localMid;
    const noon = new Date(`${renewal.date}T12:00:00`);
    dateLabel = dayShort.format(noon);
    fullDate = dateMedium.format(noon);
    daysLeft = Math.round((localMid - todayMid) / 86400000);
    inputDate = renewal.date;
    countdown = daysLeft < 0 ? `${Math.abs(daysLeft)}d ago` : daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft}d`;
  } else if (renewal.nextAt) {
    const ms = Date.parse(renewal.nextAt);
    if (!Number.isFinite(ms)) return null;
    sortMs = ms;
    const target = new Date(ms);
    dateLabel = dayShort.format(target);
    fullDate = dateTime.format(target);
    inputDate = dayKey.format(target);
    const diffMs = ms - now;
    if (diffMs <= 0) {
      daysLeft = 0;
      countdown = "now";
    } else if (diffMs < 86400000) {
      daysLeft = 0;
      const hours = Math.max(1, Math.round(diffMs / 3600000));
      countdown = `in ${hours}h`;
    } else {
      const targetMid = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
      daysLeft = Math.max(1, Math.round((targetMid - todayMid) / 86400000));
      countdown = daysLeft === 1 ? "tomorrow" : `in ${daysLeft}d`;
    }
  } else {
    return null;
  }

  const prefix = renewal.estimated ? "~" : "";
  const ended = renewal.cadence === "none" && daysLeft !== null && daysLeft < 0;
  const verb = renewal.verb ?? (ended ? "Ended" : renewal.cadence === "none" ? "Ends" : "Renews");
  const soon = !ended && daysLeft !== null && daysLeft >= 0 && daysLeft <= 5;
  const sortGroup = ended ? 1 : 0;
  const tip = [
    `${verb} ${prefix}${fullDate} (${countdown})`,
    renewal.basis ?? null,
    "Click Edit to set an exact date or mark as cancelled.",
  ].filter(Boolean).join("\n");

  return {
    sortGroup,
    sortMs,
    dateLabel: `${prefix}${dateLabel}`,
    fullDate,
    daysLeft,
    countdown: ended ? "Ended" : countdown,
    inputDate,
    cadence: renewal.cadence ?? "monthly",
    cadenceLabel: ended ? "Ended" : renewal.cadence ? (CADENCE_LABELS[renewal.cadence] ?? "—") : "—",
    verb,
    soon,
    ended,
    estimated: Boolean(renewal.estimated),
    hasOverride: Boolean(renewal.hasOverride),
    tip,
  };
}

function renderRenewalEditor(account, info, draft = null) {
  const defaultDate = draft?.date ?? info?.inputDate ?? dayKey.format(new Date(Date.now() + 30 * 86400000));
  const defaultCadence = draft?.cadence ?? info?.cadence ?? "monthly";
  const disabled = state.savingRenewal ? " disabled" : "";
  return `<form class="renewal-form" data-renewal-form="${escapeHtml(account.id)}">
    <label class="renewal-field">
      <span>Next cycle</span>
      <input type="date" name="date" value="${escapeHtml(defaultDate)}" required${disabled}>
    </label>
    <label class="renewal-field">
      <span>Cadence</span>
      <select name="cadence"${disabled}>
        <option value="monthly"${defaultCadence === "monthly" ? " selected" : ""}>Monthly</option>
        <option value="quarterly"${defaultCadence === "quarterly" ? " selected" : ""}>Quarterly</option>
        <option value="annual"${defaultCadence === "annual" ? " selected" : ""}>Annual</option>
        <option value="none"${defaultCadence === "none" ? " selected" : ""}>Ends / cancelled</option>
      </select>
    </label>
    <div class="renewal-form-actions">
      <button type="submit" class="btn-small primary"${disabled}>${state.savingRenewal ? "Saving…" : "Save"}</button>
      ${info?.hasOverride ? `<button type="button" class="btn-small" data-renewal-clear="${escapeHtml(account.id)}"${disabled}>Reset</button>` : ""}
      <button type="button" class="btn-small" data-renewal-cancel${disabled}>Cancel</button>
    </div>
  </form>`;
}

function renderRenewalsSection(accounts, now, draft) {
  const rows = accounts
    .map((account) => ({ account, info: renewalDetails(account.renewal, now) }))
    .sort((a, b) =>
      (a.info?.sortGroup ?? 2) - (b.info?.sortGroup ?? 2) ||
      (a.info?.sortMs ?? Infinity) - (b.info?.sortMs ?? Infinity) ||
      a.account.label.localeCompare(b.account.label),
    );

  const body = rows.map(({ account, info }) => {
    const color = providerColor(account.provider);
    const link = account.externalUsage?.url ? safeLink(account.externalUsage.url) : null;
    const editing = state.editingRenewal === account.id;
    const dateCell = info
      ? `<span class="${info.soon ? "renewal-soon" : info.ended ? "muted" : "fg"}" data-tip="${escapeHtml(info.tip)}">${escapeHtml(info.dateLabel)}</span>`
      : '<span class="muted">Not set</span>';
    const countdownCell = info
      ? `<span class="${info.soon ? "renewal-soon" : info.ended ? "muted" : ""}">${escapeHtml(info.countdown)}</span>`
      : '<span class="muted">—</span>';
    const cadenceCell = info
      ? `<span class="muted">${escapeHtml(info.cadenceLabel)}${info.estimated ? " · est." : ""}</span>`
      : '<span class="muted">—</span>';
    const editorRow = editing
      ? `<tr class="renewal-editor-row"><td colspan="5">${renderRenewalEditor(account, info, draft?.accountId === account.id ? draft : null)}</td></tr>`
      : "";
    return `<tr>
      <td class="left"><div class="model-cell"><span class="dot" style="background:${color}"></span>${escapeHtml(account.label)}</div></td>
      <td class="figure">${dateCell}</td>
      <td class="figure">${countdownCell}</td>
      <td class="hide-sm">${cadenceCell}</td>
      <td class="renewal-actions"><div class="renewal-actions-inner">
        <button type="button" class="link-btn" data-renewal-edit="${escapeHtml(account.id)}">${info ? "Edit" : "Set"}</button>
        ${link ? `<a class="account-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Manage ↗</a>` : ""}
      </div></td>
    </tr>${editorRow}`;
  }).join("");

  return `<section class="section">
    <div class="section-head">
      <h2>Next billing cycles</h2>
      <span class="account-meta">Sorted soonest first · ~ estimated from signup date</span>
    </div>
    <div class="table-wrap">
      <table class="renewals-table">
        <thead><tr><th class="left">Subscription</th><th>Next cycle</th><th>In</th><th class="hide-sm">Cycle</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

async function saveRenewal(accountId, { date, cadence }) {
  if (state.savingRenewal) return;
  const saveId = ++renewalSaveId;
  state.savingRenewal = true;
  prefetchController?.abort();
  backgroundLimitsController?.abort();
  renderLimits();
  try {
    const body = await fetchJsonWithTimeout("/api/renewals", null, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, date, cadence }),
    });
    if (saveId !== renewalSaveId) return;
    limitsVersion += 1;
    state.savingRenewal = false;
    if (state.editingRenewal === accountId) state.editingRenewal = null;
    applyLimits(body.limits, { updateTimestamp: false });
  } catch (error) {
    if (saveId !== renewalSaveId) return;
    state.savingRenewal = false;
    renderLimits();
    $("notices").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
}

function captureRenewalDraft() {
  if (!state.editingRenewal) return null;
  const form = $("limitsView").querySelector(`[data-renewal-form="${CSS.escape(state.editingRenewal)}"]`);
  if (!form) return null;
  const dateInput = form.querySelector('input[name="date"]');
  const cadenceSelect = form.querySelector('select[name="cadence"]');
  const focusedName =
    document.activeElement === dateInput ? "date" :
    document.activeElement === cadenceSelect ? "cadence" : null;
  return {
    accountId: state.editingRenewal,
    date: dateInput?.value ?? null,
    cadence: cadenceSelect?.value ?? null,
    focusedName,
  };
}

function renderLimits() {
  const now = Date.now();
  const accounts = state.data.limits;
  if (accounts.length === 0) {
    $("limitsView").innerHTML = '<p class="muted">No provider reports limits.</p>';
    return;
  }
  const draft = captureRenewalDraft();
  const renewalsSummary = renderRenewalsSection(accounts, now, draft);
  $("limitsView").innerHTML = `${renewalsSummary}<div class="limits">${accounts.map((account) => {
    const color = providerColor(account.provider);
    const link = account.externalUsage?.url ? safeLink(account.externalUsage.url) : null;
    const checked = account.checkedAt ? ` · checked ${ago(account.checkedAt, now)}` : "";
    const info = renewalDetails(account.renewal, now);
    const renewalTag = info
      ? `<button type="button" class="renewal-pill${info.soon ? " soon" : ""}" data-renewal-edit="${escapeHtml(account.id)}" data-tip="${escapeHtml(info.tip)}">${escapeHtml(`${info.verb} ${info.dateLabel} · ${info.countdown}`)}</button>`
      : `<button type="button" class="renewal-pill unset" data-renewal-edit="${escapeHtml(account.id)}">Set renewal</button>`;
    const staleNote = account.stale
      ? `<p class="account-empty">Showing the last reading. ${escapeHtml(account.stale.reason)}</p>`
      : "";
    const windows = account.windows?.length
      ? `${staleNote}<div class="windows${account.stale ? " stale" : ""}">${account.windows.map((window) => {
          const remaining = Math.max(0, Math.round(100 - window.usedPercent));
          const timeLeft = windowTiming(window, now);
          const pace = paceOf(window, timeLeft);
          const resets = resetsIn(window, now);
          const resetAt = window.resetsAt ? dateTime.format(new Date(window.resetsAt)) : null;
          const tip = [
            timeLeft !== null ? `${remaining}% left · ${timeLeft}% of the window left` : `${remaining}% left`,
            timeLeft !== null ? "The line is where even spending would be." : null,
            resetAt ? `Resets ${resetAt}${resets ? ` · in ${resets}` : ""}` : null,
          ].filter(Boolean).join("\n");
          const tickAt = timeLeft === null ? null : `clamp(3px, ${timeLeft}%, calc(100% - 3px))`;
          return `
            <span class="win-label"><span class="truncate muted">${escapeHtml(window.label)}</span><span class="left">${remaining}% left</span></span>
            <div class="win-bar" role="img" tabindex="0" aria-label="${escapeHtml(`${window.label}: ${tip.replace(/\n/g, ", ")}`)}" data-tip="${escapeHtml(tip)}">
              <div class="track"></div>
              ${remaining > 0 ? `<div class="fill" style="width:${remaining}%;background:${color}"></div>` : ""}
              ${tickAt ? `<span class="tick" style="left:${tickAt}"></span>` : ""}
            </div>
            <span class="win-meta">${pace ? `<span class="pace" data-tip="${escapeHtml(PACE[pace].label)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="${escapeHtml(PACE[pace].label)}">${PACE[pace].icon}</svg></span>` : ""}<span class="resets">${resets ? `in ${resets}` : ""}</span></span>`;
        }).join("")}</div>`
      : `<p class="account-empty">${escapeHtml(account.unavailable?.message ?? "No limit windows reported.")}</p>`;
    return `<section class="account">
      <div class="account-head">
        <span class="account-name"><span class="dot" style="background:${color}"></span>${escapeHtml(account.label)}</span>
        <span class="account-meta">${escapeHtml(account.source ?? "")}${escapeHtml(checked)}</span>
        ${renewalTag}
        ${link ? `<a class="account-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Manage ↗</a>` : ""}
      </div>
      ${windows}
    </section>`;
  }).join("")}</div>`;
  if (draft?.focusedName && state.editingRenewal === draft.accountId && !state.savingRenewal) {
    $("limitsView").querySelector(`[data-renewal-form="${CSS.escape(draft.accountId)}"] [name="${draft.focusedName}"]`)?.focus();
  }
}

/* ---------- Tooltips ---------- */

const infoIcon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

function showTooltip(html, x, y) {
  const tip = $("tooltip");
  tip.innerHTML = html;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2));
  const top = y - height - 8 < 8 ? y + 24 : y - height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTooltip = () => { $("tooltip").hidden = true; };

function tipTarget(event) {
  return event.target instanceof Element ? event.target.closest("[data-tip]") : null;
}
document.addEventListener("pointerover", (event) => {
  const target = tipTarget(event);
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  const lines = target.dataset.tip.split("\n").map((line, i) => `<div class="${i === 0 ? "" : "tt-note"}">${escapeHtml(line)}</div>`).join("");
  showTooltip(lines, bounds.left + bounds.width / 2, bounds.top);
});
document.addEventListener("pointerout", (event) => {
  if (tipTarget(event) && !event.relatedTarget?.closest?.("[data-tip]")) hideTooltip();
});
document.addEventListener("focusin", (event) => {
  const target = tipTarget(event);
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  showTooltip(escapeHtml(target.dataset.tip).replace(/\n/g, "<br>"), bounds.left + bounds.width / 2, bounds.top);
});
document.addEventListener("focusout", hideTooltip);

/* ---------- Controls ---------- */

for (const button of document.querySelectorAll("[data-days]")) {
  button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    writePreference("days", String(state.days));
    load();
  });
}
for (const button of document.querySelectorAll("[data-metric]")) {
  button.addEventListener("click", () => {
    state.metric = button.dataset.metric;
    writePreference("metric", state.metric);
    syncControls();
    render();
    if (!state.data) {
      if (!state.loading) load();
    } else if (state.metric === "limits") {
      if (!state.editingRenewal && Date.now() - lastLimitsAt >= PERIOD_TTL_MS) refreshLimits({ force: true, showLoading: true });
    } else {
      const held = periodCache.get(state.days);
      if (!held || Date.now() - held.at >= PERIOD_TTL_MS) load();
      else prefetchOtherPeriods();
    }
  });
}
$("usageView").addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-breakdown]") : null;
  if (!button) return;
  state.breakdown = button.dataset.breakdown;
  renderUsage();
});
$("limitsView").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const edit = event.target.closest("[data-renewal-edit]");
  if (edit) {
    const id = edit.dataset.renewalEdit;
    state.editingRenewal = state.editingRenewal === id ? null : id;
    hideTooltip();
    renderLimits();
    if (state.editingRenewal) {
      const input = $("limitsView").querySelector(`[data-renewal-form="${CSS.escape(id)}"] input[name="date"]`);
      input?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      input?.focus();
    }
    return;
  }
  const clear = event.target.closest("[data-renewal-clear]");
  if (clear) {
    saveRenewal(clear.dataset.renewalClear, { date: null });
    return;
  }
  if (event.target.closest("[data-renewal-cancel]")) {
    state.editingRenewal = null;
    renderLimits();
  }
});
$("limitsView").addEventListener("submit", (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target.closest("[data-renewal-form]") : null;
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  saveRenewal(form.dataset.renewalForm, {
    date: String(data.get("date") ?? ""),
    cadence: String(data.get("cadence") ?? "monthly"),
  });
});
$("refresh").addEventListener("click", () => {
  if (state.metric === "limits" && state.data) refreshLimits({ force: true, showLoading: true });
  else load(true);
});
// Limits change while the page sits open: poll fresh limits once a minute while visible.
setInterval(() => {
  if (document.hidden || state.loading || !state.data || state.editingRenewal) return;
  if (state.metric === "limits" && Date.now() - lastLimitsAt >= PERIOD_TTL_MS) {
    refreshLimits({ force: true, showLoading: false });
  }
}, 15000);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.editingRenewal && !state.savingRenewal) {
    state.editingRenewal = null;
    renderLimits();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden || state.loading || !state.data) return;
  if (state.metric === "limits") {
    if (!state.editingRenewal && Date.now() - lastLimitsAt >= PERIOD_TTL_MS) refreshLimits({ force: true, showLoading: false });
  } else {
    const held = periodCache.get(state.days);
    if (!held || Date.now() - held.at >= PERIOD_TTL_MS) load();
  }
});

syncControls();
load();
