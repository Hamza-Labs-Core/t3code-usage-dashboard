const FIRST_PARTY = new Set([
  "anthropic",
  "deepseek",
  "gemini",
  "meta",
  "mistral",
  "openai",
  "xai",
]);
const UNPRICED = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);
const SPEEDS = ["standard", "fast", "ultrafast"];

export const emptyTotals = () => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

export const totalTokens = (totals) =>
  totals.uncachedInputTokens +
  totals.cachedInputTokens +
  totals.cacheCreationTokens +
  totals.outputTokens;

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const normalizeKey = (model) => model.trim().toLowerCase();
const bareModel = (model) => model.slice(model.lastIndexOf("/") + 1);

function readRates(entry, suffix = "", standard, outputFallback) {
  const input = finite(entry[`input_cost_per_token${suffix}`]);
  const output = finite(entry[`output_cost_per_token${suffix}`]) ?? outputFallback ?? null;
  if (input === null || output === null) return null;
  const read = (name, field, fallback = input) =>
    finite(entry[`${name}${suffix}`]) ??
    (standard && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : fallback);
  const cacheCreation = read("cache_creation_input_token_cost", "cacheCreationCostPerToken");
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: read("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheCreation,
    cacheCreation1hCostPerToken: read(
      "cache_creation_input_token_cost_above_1hr",
      "cacheCreation1hCostPerToken",
      cacheCreation,
    ),
  };
}

const scaleRates = (rates, multiple) =>
  Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, value * multiple]));

function speedRates(entry, standard, suffix = "") {
  const specific = entry.provider_specific_entry;
  const multiplier = finite(specific?.fast);
  return {
    ...standard,
    fast:
      multiplier !== null && multiplier > 0
        ? scaleRates(standard, multiplier)
        : readRates(entry, `${suffix}_priority`, standard),
    ultrafast: readRates(entry, `${suffix}_ultrafast`, standard),
  };
}

function contextTiers(entry, base) {
  const thresholds = new Set();
  for (const key of Object.keys(entry)) {
    const match = /^input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?$/.exec(key);
    if (match) thresholds.add(match[1]);
  }
  return [...thresholds]
    .map((threshold) => {
      const suffix = `_above_${threshold}k_tokens`;
      const standard = readRates(entry, suffix, base, base.outputCostPerToken) ?? base;
      return {
        thresholdTokens: Number(threshold) * 1000,
        rate: speedRates(entry, standard, suffix),
      };
    })
    .sort((a, b) => b.thresholdTokens - a.thresholdTokens);
}

function sameRates(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken &&
    a.cacheCreation1hCostPerToken === b.cacheCreation1hCostPerToken
  );
}

function compatibleRates(a, b) {
  return (
    sameRates(a, b) &&
    sameRates(a.fast, b.fast ?? a.fast) &&
    sameRates(a.ultrafast, b.ultrafast ?? a.ultrafast)
  );
}

export function parseRateTable(document) {
  const table = new Map();
  if (!document || typeof document !== "object") return table;
  for (const [name, entry] of Object.entries(document)) {
    if (!entry || typeof entry !== "object") continue;
    const standard = readRates(entry);
    if (!standard) continue;
    const key = normalizeKey(name);
    if (key) table.set(key, { ...speedRates(entry, standard), contextTiers: contextTiers(entry, standard) });
  }
  const aliases = new Map();
  for (const [key, rate] of table) {
    const slash = key.indexOf("/");
    const alias = slash === -1 && key.startsWith("anthropic.") ? key.slice(10) : bareModel(key);
    if (!alias || alias === key || table.has(alias)) continue;
    const firstParty = slash !== -1 && FIRST_PARTY.has(key.slice(0, slash));
    const held = aliases.get(alias);
    if (!held || (firstParty && !held.firstParty)) aliases.set(alias, { rate, firstParty });
    else if (held.rate && firstParty === held.firstParty && !compatibleRates(held.rate, rate)) {
      aliases.set(alias, { rate: null, firstParty });
    }
  }
  for (const [alias, { rate }] of aliases) if (rate) table.set(alias, rate);
  return table;
}

export function overrideRateTable(overrides = {}) {
  const table = new Map();
  for (const [model, prices] of Object.entries(overrides)) {
    if (!prices || typeof prices !== "object") continue;
    const input = finite(prices.inputCostPerMillionTokens);
    const output = finite(prices.outputCostPerMillionTokens);
    if (input === null || output === null) continue;
    const cacheWrite = (finite(prices.cacheWriteCostPerMillionTokens) ?? input) / 1e6;
    table.set(model.trim(), {
      inputCostPerToken: input / 1e6,
      outputCostPerToken: output / 1e6,
      cacheReadCostPerToken: (finite(prices.cacheReadCostPerMillionTokens) ?? input) / 1e6,
      cacheCreationCostPerToken: cacheWrite,
      cacheCreation1hCostPerToken: cacheWrite,
      fast: null,
      ultrafast: null,
      contextTiers: [],
    });
  }
  return table;
}

export function resolveAliases(aliases = {}) {
  const resolved = new Map();
  for (const model of Object.keys(aliases)) {
    const seen = new Set();
    let target = model;
    while (typeof aliases[target] === "string" && !seen.has(target)) {
      seen.add(target);
      target = aliases[target];
    }
    if (target !== model && !Object.hasOwn(aliases, target)) resolved.set(model, target);
  }
  return resolved;
}

export function lookupRate(table, model) {
  const key = normalizeKey(model).split("[")[0];
  const bare = bareModel(key);
  if (!bare || UNPRICED.has(bare)) return null;
  return table.get(key) ?? null;
}

function ratesAt(rate, speed, totals) {
  const prompt = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  const tier = rate.contextTiers.find((candidate) => prompt > candidate.thresholdTokens)?.rate;
  if (speed === "standard") return tier ?? rate;
  return tier?.[speed] ?? rate[speed] ?? tier ?? rate;
}

function categoryCost(record, rates) {
  const totals = record.totals;
  const oneHour = Math.min(record.cacheCreation1hTokens ?? 0, totals.cacheCreationTokens);
  return {
    input: totals.uncachedInputTokens * rates.inputCostPerToken,
    cacheRead: totals.cachedInputTokens * rates.cacheReadCostPerToken,
    cacheWrite:
      (totals.cacheCreationTokens - oneHour) * rates.cacheCreationCostPerToken +
      oneHour * rates.cacheCreation1hCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken,
  };
}

const sumCost = (cost) => cost.input + cost.cacheRead + cost.cacheWrite + cost.output;

function resolveRate(rates, record, overrides) {
  return overrides.get(record.model.trim()) ?? lookupRate(rates, record.rateModel ?? "") ?? lookupRate(rates, record.model);
}

// Rate resolution normalizes model names; memoize it per (rateModel, model) for one aggregation.
function rateResolver(rates, overrides) {
  const memo = new Map();
  return (record) => {
    const key = `${record.rateModel ?? ""}\0${record.model}`;
    if (!memo.has(key)) memo.set(key, resolveRate(rates, record, overrides));
    return memo.get(key);
  };
}

export function priceRecord(rates, record, overrides, resolved) {
  const override = overrides.get(record.model.trim());
  const reported =
    override === undefined && finite(record.reportedCostUsd) !== null ? record.reportedCostUsd : null;
  const rate = resolved === undefined ? resolveRate(rates, record, overrides) : resolved;
  if (!rate) return { costUsd: reported ?? 0, costSource: reported === null ? "unpriced" : "providerReported", categoryCostUsd: null };
  const categories = categoryCost(record, ratesAt(rate, record.speed, record.totals));
  const listCost = sumCost(categories);
  if (reported !== null && listCost <= 0) {
    return { costUsd: reported, costSource: "providerReported", categoryCostUsd: null };
  }
  const scale = reported === null ? 1 : reported / listCost;
  return {
    costUsd: reported ?? listCost,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: scale === 1
      ? categories
      : { input: categories.input * scale, cacheRead: categories.cacheRead * scale, cacheWrite: categories.cacheWrite * scale, output: categories.output * scale },
  };
}

export function cacheSavings(rates, record, overrides, resolved) {
  const rate = resolved === undefined ? resolveRate(rates, record, overrides) : resolved;
  if (!rate) return 0;
  const current = ratesAt(rate, record.speed, record.totals);
  return record.totals.cachedInputTokens * (current.inputCostPerToken - current.cacheReadCostPerToken);
}

function mergeCopies(held, copy) {
  const result = { ...held, totals: {}, reportedCostUsd: held.reportedCostUsd ?? copy.reportedCostUsd };
  for (const key of Object.keys(emptyTotals())) {
    result.totals[key] = Math.max(held.totals[key], copy.totals[key]);
  }
  result.cacheCreation1hTokens = Math.max(held.cacheCreation1hTokens ?? 0, copy.cacheCreation1hTokens ?? 0);
  if (held.reportedCostUsd !== null && copy.reportedCostUsd !== null) {
    result.reportedCostUsd = Math.max(held.reportedCostUsd, copy.reportedCostUsd);
  }
  return result;
}

function dayFormatter(timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const cache = new Map();
  return (timestamp) => {
    const slot = Math.floor(timestamp / 900000);
    if (!cache.has(slot)) cache.set(slot, formatter.format(new Date(timestamp)));
    return cache.get(slot);
  };
}

function newAggregate() {
  return {
    totals: emptyTotals(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    records: 0,
    unpricedRecords: 0,
    unpricedTokens: 0,
    providerReportedRecords: 0,
    sessions: new Set(),
  };
}

const TOTAL_KEYS = Object.keys(emptyTotals());

function accumulate(target, record, priced, savings) {
  for (const key of TOTAL_KEYS) target.totals[key] += record.totals[key];
  target.costUsd += priced.costUsd;
  target.cacheSavingsUsd += savings;
  if (priced.categoryCostUsd) {
    for (const key of Object.keys(target.categoryCostUsd)) {
      target.categoryCostUsd[key] += priced.categoryCostUsd[key];
    }
  }
  target.records += 1;
  if (priced.costSource === "unpriced") {
    target.unpricedRecords += 1;
    target.unpricedTokens += totalTokens(record.totals);
  }
  if (priced.costSource === "providerReported") target.providerReportedRecords += 1;
  if (record.sessionId) target.sessions.add(record.sessionId);
}

function costSource(aggregate) {
  if (aggregate.records > 0 && aggregate.unpricedRecords === aggregate.records) return "unpriced";
  if (aggregate.records > 0 && aggregate.providerReportedRecords === aggregate.records) return "providerReported";
  return "modelPriced";
}

function publicAggregate(aggregate) {
  return {
    totals: aggregate.totals,
    totalTokens: totalTokens(aggregate.totals),
    costUsd: aggregate.costUsd,
    cacheSavingsUsd: aggregate.cacheSavingsUsd,
    categoryCostUsd: aggregate.categoryCostUsd,
    records: aggregate.records,
    sessions: aggregate.sessions.size,
    unpricedTokens: aggregate.unpricedTokens,
    costSource: costSource(aggregate),
  };
}

export function aggregateRecords(records, options) {
  const { sinceMs, untilMs, timeZone, rates, overrides, aliases, modelFilter, multiAccountProviders = new Set() } = options;
  const toDay = dayFormatter(timeZone);
  const seen = new Map();
  const deduped = [];
  let duplicatesDropped = 0;
  for (const original of records) {
    if (original.timestampMs < sinceMs || original.timestampMs >= untilMs) continue;
    if (modelFilter) {
      const matches = (selector) =>
        selector.model === original.model && (!selector.provider || selector.provider === original.provider);
      if (!(modelFilter.include?.some(matches) ?? true) || modelFilter.exclude?.some(matches)) continue;
    }
    const alias = aliases.get(original.model);
    const record = alias
      ? {
          ...original,
          model: alias,
          rateModel: lookupRate(rates, alias)
            ? undefined
            : original.provider === "zai"
              ? `zai/${alias}`
              : original.rateModel,
        }
      : original;
    if (record.dedupeKey) {
      const heldIndex = seen.get(record.dedupeKey);
      if (heldIndex !== undefined) {
        deduped[heldIndex] = mergeCopies(deduped[heldIndex], record);
        duplicatesDropped += 1;
        continue;
      }
      seen.set(record.dedupeKey, deduped.length);
    }
    deduped.push(record);
  }

  const resolve = rateResolver(rates, overrides);
  const total = newAggregate();
  const providers = new Map();
  const accountsByProvider = new Map();
  const models = new Map();
  const trend = new Map();
  const accountTrend = new Map();
  const hourly = untilMs - sinceMs <= 36 * 3600000;
  for (const record of deduped) {
    const rate = resolve(record);
    const priced = priceRecord(rates, record, overrides, rate);
    const savings = cacheSavings(rates, record, overrides, rate);
    accumulate(total, record, priced, savings);
    const providerKey = record.provider;
    if (!providers.has(providerKey)) providers.set(providerKey, { provider: providerKey, ...newAggregate() });
    accumulate(providers.get(providerKey), record, priced, savings);
    const modelKey = `${record.provider}\0${record.model}`;
    if (!models.has(modelKey)) models.set(modelKey, { provider: record.provider, model: record.model, ...newAggregate() });
    accumulate(models.get(modelKey), record, priced, savings);
    const day = toDay(record.timestampMs);
    const bucket = hourly
      ? new Date(Math.floor(record.timestampMs / 3600000) * 3600000).toISOString()
      : day;
    const trendKey = `${bucket}\0${record.provider}`;
    if (!trend.has(trendKey)) trend.set(trendKey, { bucket, provider: record.provider, tokens: 0, costUsd: 0 });
    const point = trend.get(trendKey);
    const recordTokens = totalTokens(record.totals);
    point.tokens += recordTokens;
    point.costUsd += priced.costUsd;

    if (record.accountId) {
      let providerAccounts = accountsByProvider.get(providerKey);
      if (!providerAccounts) {
        providerAccounts = new Map();
        accountsByProvider.set(providerKey, providerAccounts);
      }
      if (!providerAccounts.has(record.accountId)) {
        providerAccounts.set(record.accountId, {
          id: record.accountId,
          label: record.accountLabel || record.accountId,
          provider: providerKey,
          ...newAggregate(),
        });
      }
      accumulate(providerAccounts.get(record.accountId), record, priced, savings);

      const accTrendKey = `${bucket}\0${providerKey}\0${record.accountId}`;
      if (!accountTrend.has(accTrendKey)) {
        accountTrend.set(accTrendKey, {
          bucket,
          provider: providerKey,
          accountId: record.accountId,
          tokens: 0,
          costUsd: 0,
        });
      }
      const accPoint = accountTrend.get(accTrendKey);
      accPoint.tokens += recordTokens;
      accPoint.costUsd += priced.costUsd;
    }
  }
  const finalizeMap = (map) =>
    [...map.values()].map((value) => ({ ...value, ...publicAggregate(value) }));
  const finalizedProviders = finalizeMap(providers)
    .map((entry) => {
      const accountMap = accountsByProvider.get(entry.provider);
      const accounts = accountMap
        ? finalizeMap(accountMap).sort((a, b) => b.totalTokens - a.totalTokens)
        : [];
      const multiAccount = accounts.length > 1 || (accounts.length > 0 && multiAccountProviders.has(entry.provider));
      return {
        ...entry,
        multiAccount,
        accounts: multiAccount ? accounts : [],
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const multiProviderSet = new Set(finalizedProviders.filter((p) => p.multiAccount).map((p) => p.provider));
  return {
    summary: publicAggregate(total),
    providers: finalizedProviders,
    models: finalizeMap(models).sort((a, b) => b.totalTokens - a.totalTokens),
    trend: [...trend.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    accountTrend: [...accountTrend.values()]
      .filter((point) => multiProviderSet.has(point.provider))
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    duplicatesDropped,
    records: deduped.length,
  };
}

export function decodeCacheRecord(row, provider, models, sessions, version) {
  if (!Array.isArray(row) || row.length < 11) return null;
  const [timestampMs, modelIndex, sessionIndex, uncached, cached, cacheCreation, output, reasoning, dedupeKey, reportedCostUsd, speedIndex, rateModelIndex, unresolved, cacheCreation1h = 0] = row;
  const model = models[modelIndex];
  const speed = SPEEDS[speedIndex];
  if (!Number.isFinite(timestampMs) || !model || !speed) return null;
  if ([uncached, cached, cacheCreation, output, reasoning].some((value) => !Number.isFinite(value))) return null;
  return {
    provider,
    timestampMs,
    model,
    rateModel: typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined,
    sessionId: sessions[sessionIndex] ?? "",
    totals: { uncachedInputTokens: uncached, cachedInputTokens: cached, cacheCreationTokens: cacheCreation, outputTokens: output, reasoningTokens: reasoning },
    cacheCreation1hTokens: cacheCreation1h,
    reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
    speed,
    dedupeKey:
      provider === "grok" && version < 17 && typeof dedupeKey === "string" && dedupeKey.endsWith(`:${model}`) && !dedupeKey.endsWith(`:${timestampMs}:${model}`)
        ? `${dedupeKey.slice(0, -model.length)}${timestampMs}:${model}`
        : typeof dedupeKey === "string" ? dedupeKey : null,
    unresolvedServiceTierTurnId: unresolved,
  };
}
