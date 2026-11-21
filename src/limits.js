import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as Toml from "smol-toml";
import { config } from "./config.js";
import { clampPercent, isoDate, readJson } from "./util.js";

const KIMI_DEFAULT_OAUTH = "https://auth.kimi.com";
const KIMI_DEFAULT_BASE = "https://api.kimi.com/coding/v1";
const KIMI_WINDOWS = [
  { key: "limit_5h", label: "5-hour", kind: "session", minutes: 300 },
  { key: "limit_7d", label: "Weekly", kind: "weekly", minutes: 10080 },
  { key: "limit_month_total", label: "Monthly", kind: "monthly", minutes: 43200 },
];
const UNIT_MINUTES = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440, TIME_UNIT_WEEK: 10080 };

const providerName = (driver) => ({
  claudeAgent: "claude",
  codex: "codex",
  opencode: "opencode",
  grok: "grok",
  cursor: "cursor",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
}[driver] ?? driver);

function mapWindow(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.label) return null;
  return {
    id: String(raw.id),
    label: String(raw.label),
    kind: ["session", "weekly", "monthly", "other"].includes(raw.kind) ? raw.kind : "other",
    usedPercent: clampPercent(raw.usedPercent),
    resetsAt: isoDate(raw.resetsAt),
    windowDurationMins: Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : undefined,
    used: Number.isFinite(raw.used) ? raw.used : undefined,
    limit: Number.isFinite(raw.limit) ? raw.limit : undefined,
    remaining: Number.isFinite(raw.remaining) ? raw.remaining : undefined,
    unit: typeof raw.unit === "string" ? raw.unit : undefined,
  };
}

export function readT3Limits() {
  const accounts = [];
  let entries = [];
  try {
    entries = fs.readdirSync(config.t3Cache, { withFileTypes: true });
  } catch {
    return accounts;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const snapshot = readJson(path.join(config.t3Cache, entry.name));
    if (!snapshot?.usageLimits || !snapshot.instanceId) continue;
    const limits = snapshot.usageLimits;
    accounts.push({
      id: `t3:${snapshot.instanceId}`,
      provider: providerName(snapshot.driver),
      label: snapshot.displayName ?? snapshot.instanceId,
      instanceId: snapshot.instanceId,
      driver: snapshot.driver,
      checkedAt: isoDate(limits.checkedAt) ?? isoDate(snapshot.checkedAt),
      windows: (limits.windows ?? []).map(mapWindow).filter(Boolean),
      unavailable: limits.unavailable ?? null,
      externalUsage: limits.externalUsage ?? null,
      source: "T3 provider cache",
    });
  }
  return accounts;
}

function instanceEntries(settings, agentIds) {
  return Object.entries(settings.providerInstances ?? {}).filter(([, instance]) =>
    instance?.driver === "acpRegistry" && agentIds.has(instance?.config?.agentId));
}

function instanceEnvironment(instance) {
  const environment = {};
  const entries = Array.isArray(instance?.environment) ? instance.environment : [];
  for (const entry of entries) {
    if (entry?.name && typeof entry.value === "string" && entry.valueRedacted !== true) {
      environment[entry.name] = entry.value;
    }
  }
  return environment;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (text.length > 256 * 1024) throw new Error("Provider quota response was too large.");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Provider returned an invalid quota response.");
  }
  return { status: response.status, ok: response.ok, body };
}

const describeError = (error, fallback) => {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause : null;
  return cause ? `${error.message}: ${cause.code ?? cause.message}` : error.message;
};

const unavailable = (message, reason = "probeFailed") => ({
  checkedAt: new Date().toISOString(),
  windows: [],
  unavailable: { reason, message },
});

function zaiUrl(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"].includes(url.hostname)
  ) throw new Error("Quota lookup requires a supported Z.ai or BigModel HTTPS endpoint.");
  return new URL("/api/monitor/usage/quota/limit", url.origin).href;
}

function zaiWindows(body) {
  const envelope = body?.data ?? {};
  if (body?.success === false || (body?.code !== undefined && ![0, 200, "0", "200"].includes(body.code))) {
    throw new Error("Z.ai could not return Coding Plan quota.");
  }
  if (!Array.isArray(envelope.limits)) throw new Error("Z.ai returned no usable quota data.");
  const occurrences = new Map();
  const windows = [];
  for (const row of envelope.limits.slice(0, 64)) {
    if (!["CREDIT_LIMIT", "TOKENS_LIMIT", "TIME_LIMIT"].includes(row?.type)) continue;
    const used = Number.isFinite(row.currentValue) ? row.currentValue : undefined;
    const limit = Number.isFinite(row.usage) ? row.usage : undefined;
    const percentage = Number.isFinite(row.percentage)
      ? row.percentage
      : used !== undefined && limit > 0 ? used / limit * 100 : undefined;
    if (percentage === undefined) continue;
    const count = Number.isFinite(row.number) ? row.number : undefined;
    const unitMinutes = { 3: 60, 4: 1440, 5: 43200, 6: 10080 }[String(row.unit)];
    const minutes = unitMinutes && count ? unitMinutes * count : undefined;
    const tool = row.type === "TIME_LIMIT";
    const base = `${row.type}-${row.unit ?? "unknown"}-${count ?? "unknown"}`.toLowerCase();
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const durationLabel = minutes === undefined ? "" : minutes % 43200 === 0
      ? `${minutes / 43200}-month ` : minutes % 10080 === 0
        ? `${minutes / 10080}-week ` : minutes % 1440 === 0
          ? `${minutes / 1440}-day ` : `${minutes / 60}-hour `;
    windows.push({
      id: occurrence ? `${base}-${occurrence}` : base,
      label: `${durationLabel}${tool ? "MCP" : "Model"} quota`,
      kind: minutes === undefined ? "other" : minutes >= 43200 ? "monthly" : minutes >= 10080 ? "weekly" : "session",
      usedPercent: clampPercent(percentage),
      windowDurationMins: minutes,
      resetsAt: Number.isFinite(row.nextResetTime) && row.nextResetTime > 0 ? new Date(row.nextResetTime).toISOString() : undefined,
      used,
      limit,
      remaining: Number.isFinite(row.remaining) ? row.remaining : used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined,
      unit: row.type === "CREDIT_LIMIT" ? "credits" : tool ? "calls" : undefined,
    });
  }
  if (windows.length === 0) throw new Error("Z.ai returned no usable quota data.");
  return windows;
}

async function readZaiLimits(settings) {
  const found = instanceEntries(settings, new Set(["glm-acp-agent"]));
  const instance = found[0]?.[1];
  const environment = { ...instanceEnvironment(instance), ...process.env };
  const base = environment.ACP_GLM_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4";
  const credentialsFile = path.join(environment.XDG_CONFIG_HOME ?? path.join(config.home, ".config"), "glm-acp-agent", "credentials.json");
  const key = environment.Z_AI_API_KEY || readJson(credentialsFile)?.z_ai_api_key;
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    return { id: "zai-live", provider: "zai", label: "Z.ai / GLM", ...unavailable("ACP_GLM_BASE_URL is not a valid URL.", "unsupported"), source: "Z.ai quota API" };
  }
  const externalUsage = { label: "Z.ai usage", url: host.endsWith("bigmodel.cn") ? "https://bigmodel.cn/coding-plan/personal/usage" : "https://z.ai/manage-apikey/coding-plan/personal/my-plan" };
  if (!key) return { id: "zai-live", provider: "zai", label: "Z.ai / GLM", ...unavailable("Set Z_AI_API_KEY or configure glm-acp-agent to read live limits.", "unsupported"), externalUsage, source: "Z.ai quota API" };
  try {
    const result = await fetchJson(zaiUrl(base), { Authorization: key });
    if ([401, 403].includes(result.status) || [401, 403, "401", "403"].includes(result.body?.code)) {
      return { id: "zai-live", provider: "zai", label: "Z.ai / GLM", ...unavailable("Z.ai rejected the stored API key.", "unsupported"), externalUsage, source: "Z.ai quota API" };
    }
    if (!result.ok) throw new Error(`Z.ai quota lookup failed (HTTP ${result.status}).`);
    return { id: "zai-live", provider: "zai", label: "Z.ai / GLM", checkedAt: new Date().toISOString(), windows: zaiWindows(result.body), unavailable: null, externalUsage, source: "Z.ai quota API" };
  } catch (error) {
    return { id: "zai-live", provider: "zai", label: "Z.ai / GLM", ...unavailable(describeError(error, "Z.ai quota lookup failed.")), externalUsage, source: "Z.ai quota API" };
  }
}

const nonNegative = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

function kimiWindows(body) {
  const windows = new Map();
  for (const window of KIMI_WINDOWS) {
    const entry = body?.usages?.[window.key];
    const ratio = nonNegative(entry?.used_ratio);
    if (ratio === undefined) continue;
    windows.set(window.key, {
      id: window.key,
      label: window.label,
      kind: window.kind,
      usedPercent: clampPercent(ratio * 100),
      windowDurationMins: window.minutes,
      resetsAt: isoDate(entry.reset_time),
    });
  }
  for (const row of body?.limits ?? []) {
    const used = nonNegative(row?.detail?.used);
    const limit = nonNegative(row?.detail?.limit);
    const minutes = Number(row?.window?.duration) * (UNIT_MINUTES[row?.window?.timeUnit] ?? 0);
    if (used === undefined || !limit || !Number.isFinite(minutes) || minutes <= 0) continue;
    const known = KIMI_WINDOWS.find((window) => window.minutes === minutes);
    const id = known?.key ?? `kimi-window-${minutes}`;
    if (windows.has(id)) continue;
    windows.set(id, {
      id,
      label: known?.label ?? `${minutes}-minute`,
      kind: known?.kind ?? "other",
      usedPercent: clampPercent(used / limit * 100),
      windowDurationMins: minutes,
      resetsAt: isoDate(row.detail.resetTime),
      used,
      limit,
      remaining: Math.max(0, limit - used),
    });
  }
  return [...windows.values()];
}

function kimiBaseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Kimi limits require an HTTPS endpoint.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function readKimiLimits(settings) {
  const found = instanceEntries(settings, new Set(["kimi-code", "kimi"]));
  const instance = found[0]?.[1];
  const environment = { ...instanceEnvironment(instance), ...process.env };
  const externalUsage = { label: "Kimi usage", url: "https://www.kimi.com/membership/subscription?tab=quota" };
  try {
    const home = environment.KIMI_CODE_HOME ?? config.kimiHome;
    const source = fs.existsSync(path.join(home, "config.toml")) ? fs.readFileSync(path.join(home, "config.toml"), "utf8") : "";
    const root = Toml.parse(source);
    const provider = root.providers?.["managed:kimi-code"] ?? {};
    if (provider.api_key || provider.api_key_env || provider.env?.KIMI_API_KEY) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Kimi API-key configurations do not report subscription limits.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    const oauth = provider.oauth ?? {};
    if (oauth.storage && oauth.storage !== "file") {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Kimi limits require file-based sign-in.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    const baseUrl = (environment.KIMI_CODE_BASE_URL ?? provider.base_url ?? KIMI_DEFAULT_BASE).replace(/\/+$/, "");
    const oauthHost = (environment.KIMI_CODE_OAUTH_HOST ?? environment.KIMI_OAUTH_HOST ?? oauth.oauth_host ?? KIMI_DEFAULT_OAUTH).replace(/\/+$/, "");
    const slot = oauthHost === KIMI_DEFAULT_OAUTH && baseUrl === KIMI_DEFAULT_BASE
      ? "kimi-code"
      : `kimi-code-env-${crypto.createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16)}`;
    const token = readJson(path.join(home, "credentials", `${slot}.json`));
    if (!token?.access_token) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Sign in to Kimi Code to see its limits.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    if (!Number.isFinite(token.expires_at)) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Kimi's stored sign-in has no expiry. Use Kimi once, then refresh.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    if (token.expires_at - Date.now() / 1000 <= 30) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Kimi's stored access token is expiring. Use Kimi once to renew it, then refresh.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    const base = kimiBaseUrl(baseUrl);
    const result = await fetchJson(`${base}/usages`, { Authorization: `Bearer ${token.access_token}` });
    if ([401, 403].includes(result.status)) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Kimi rejected its stored sign-in. Use Kimi once or sign in again.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    if (result.status === 404) {
      return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("This Kimi endpoint does not report plan limits.", "unsupported"), externalUsage, source: "Kimi managed API" };
    }
    if (!result.ok) throw new Error(`Kimi quota lookup failed (HTTP ${result.status}).`);
    const windows = kimiWindows(result.body);
    if (windows.length === 0) throw new Error("Kimi did not return usable quota information.");
    return { id: "kimi-live", provider: "kimi", label: "Kimi Code", checkedAt: new Date().toISOString(), windows, unavailable: null, externalUsage, source: "Kimi managed API" };
  } catch (error) {
    return { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable(describeError(error, "Kimi quota lookup failed.")), externalUsage, source: "Kimi managed API" };
  }
}

const lastGoodFile = () => path.join(config.stateDir, "last-good-limits.json");

function saveLastGood(store) {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    const temporary = `${lastGoodFile()}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store));
    fs.renameSync(temporary, lastGoodFile());
  } catch {
    // Losing the fallback only costs the stale view; the live reading is still returned.
  }
}

// Live readers fail whenever their credential lapses (Kimi's access token lasts 15 minutes), so a
// failed read falls back to the last good one. Windows that have reset since are dropped: their
// figures describe a period that is over.
function withLastGood(results) {
  const store = readJson(lastGoodFile(), {}) ?? {};
  const now = Date.now();
  let changed = false;
  const value = results.map((result) => {
    if (result.windows?.length) {
      store[result.id] = result;
      changed = true;
      return result;
    }
    const saved = store[result.id];
    if (!saved) return result;
    const windows = saved.windows.filter((window) => !window.resetsAt || Date.parse(window.resetsAt) > now);
    if (windows.length === 0) return result;
    return { ...saved, windows, unavailable: null, stale: { reason: result.unavailable?.message ?? "Live reading failed." } };
  });
  if (changed) saveLastGood(store);
  return value;
}

let cache = null;
let refreshing = null;

// Usage requests must not wait on quota APIs (each can take up to 10s): serve the last reading
// and refresh it in the background once it is a minute old. Only an explicit refresh waits.
export async function readLimits(settings, force = false) {
  if (!force && cache) {
    if (Date.now() - cache.time >= 60000 && !refreshing) {
      refreshing = fetchLimits(settings).catch(() => {}).finally(() => { refreshing = null; });
    }
    return cache.value;
  }
  return refreshing && !force ? refreshing.then(() => cache?.value ?? fetchLimits(settings)) : fetchLimits(settings);
}

let fetchGeneration = 0;

async function fetchLimits(settings) {
  // A slow background refresh must not replace a newer forced one that finished first.
  const generation = ++fetchGeneration;
  const cached = readT3Limits();
  const custom = config.liveLimits
    ? withLastGood(await Promise.all([readZaiLimits(settings), readKimiLimits(settings)]))
    : [
        { id: "zai-live", provider: "zai", label: "Z.ai / GLM", ...unavailable("Live limit lookup is disabled.", "unsupported"), source: "Z.ai quota API" },
        { id: "kimi-live", provider: "kimi", label: "Kimi Code", ...unavailable("Live limit lookup is disabled.", "unsupported"), source: "Kimi managed API" },
      ];
  const value = [...cached, ...custom].sort((a, b) => a.label.localeCompare(b.label));
  if (generation === fetchGeneration || !cache) cache = { time: Date.now(), value };
  return value;
}
