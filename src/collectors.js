import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { readT3ProviderSecret } from "./limits.js";
import {
  decodeCacheRecord,
  overrideRateTable,
  parseRateTable,
  resolveAliases,
} from "./usage.js";
import { readJson, safeError, stat } from "./util.js";

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const timestamp = (value) => {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function readT3Settings() {
  return readJson(path.join(config.t3Userdata, "settings.json"), {}) ?? {};
}

export function readPricing(settings) {
  const file = path.join(config.t3Userdata, "usage-model-rates.json");
  const cached = readJson(file, {});
  return {
    rates: parseRateTable(cached?.document),
    overrides: overrideRateTable(settings.usagePriceOverrides),
    aliases: resolveAliases(settings.usageModelAliases),
    modelFilter: settings.usageModelFilter,
    fetchedAt: cached?.fetchedAtMs ? new Date(cached.fetchedAtMs).toISOString() : null,
    file,
  };
}

function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === "~") return config.home;
  if (trimmed.startsWith("~/")) return path.join(config.home, trimmed.slice(2));
  return path.resolve(trimmed);
}

function instanceEnvValue(instanceId, instance, name) {
  const entries = Array.isArray(instance?.environment) ? instance.environment : [];
  for (const entry of entries) {
    if (entry?.name !== name) continue;
    if (entry.valueRedacted === true) return readT3ProviderSecret(instanceId, name);
    if (typeof entry.value === "string" && entry.value.trim()) return entry.value;
  }
  return null;
}

function buildAccountResolver(settings) {
  const byProvider = new Map();
  const configuredCount = new Map();
  const addMapping = (provider, dir, id, label) => {
    if (!dir) return;
    const normalized = path.resolve(dir);
    let list = byProvider.get(provider);
    if (!list) {
      list = [];
      byProvider.set(provider, list);
    }
    if (!list.some((item) => item.dir === normalized)) {
      list.push({ dir: normalized, id, label });
    }
  };
  const countAccount = (provider, id) => {
    let set = configuredCount.get(provider);
    if (!set) {
      set = new Set();
      configuredCount.set(provider, set);
    }
    set.add(id);
  };

  const instances = settings?.providerInstances ?? {};
  // Default Claude instance may be omitted from settings.providerInstances.
  const defaultClaude = instances.claudeAgent;
  const defaultClaudeDir =
    expandHome(instanceEnvValue("claudeAgent", defaultClaude, "CLAUDE_CONFIG_DIR")) ??
    expandHome(defaultClaude?.config?.homePath) ??
    expandHome(process.env.CLAUDE_CONFIG_DIR) ??
    path.join(config.home, ".claude");
  addMapping("claude", defaultClaudeDir, "claudeAgent", defaultClaude?.displayName || "Claude");
  countAccount("claude", "claudeAgent");

  const defaultCodex = instances.codex;
  const defaultCodexDir =
    expandHome(instanceEnvValue("codex", defaultCodex, "CODEX_HOME")) ??
    expandHome(defaultCodex?.config?.homePath) ??
    expandHome(process.env.CODEX_HOME) ??
    path.join(config.home, ".codex");
  addMapping("codex", defaultCodexDir, "codex", defaultCodex?.displayName || "Codex");

  for (const [id, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") continue;
    if (instance.driver === "claudeAgent") {
      const dir =
        expandHome(instanceEnvValue(id, instance, "CLAUDE_CONFIG_DIR")) ??
        expandHome(instance.config?.homePath);
      addMapping("claude", dir, id, instance.displayName || id);
      countAccount("claude", id);
    } else if (instance.driver === "codex") {
      const dir =
        expandHome(instanceEnvValue(id, instance, "CODEX_HOME")) ??
        expandHome(instance.config?.homePath);
      addMapping("codex", dir, id, instance.displayName || id);
      countAccount("codex", id);
    } else if (instance.driver === "acpRegistry" && instance.config?.agentId === "glm-acp-agent") {
      countAccount("zai", id);
    } else if (instance.driver === "antigravity") {
      countAccount("antigravity", id);
    } else if (instance.driver === "opencode") {
      countAccount("opencode", id);
    }
  }

  for (const list of byProvider.values()) {
    list.sort((a, b) => b.dir.length - a.dir.length);
  }

  const multiAccountProviders = new Set();
  for (const [provider, ids] of configuredCount) {
    if (ids.size > 1) multiAccountProviders.add(provider);
  }

  const signature = JSON.stringify(
    [...byProvider.entries()].map(([provider, list]) => [provider, list.map((item) => [item.dir, item.id, item.label])]),
  );

  function resolve(provider, filePath) {
    const list = byProvider.get(provider);
    if (!list || typeof filePath !== "string") return null;
    for (const item of list) {
      if (filePath === item.dir || filePath.startsWith(item.dir + path.sep)) {
        return { accountId: item.id, accountLabel: item.label };
      }
    }
    if (provider === "claude") {
      const marker = `${path.sep}projects${path.sep}`;
      const idx = filePath.indexOf(marker);
      if (idx > 0) {
        const root = filePath.slice(0, idx);
        const name = path.basename(root).replace(/^\.+/, "") || "Claude";
        return { accountId: `claude:${root}`, accountLabel: name };
      }
    }
    return null;
  }

  return { resolve, multiAccountProviders, signature };
}

// T3 rewrites its 46 MB usage cache only when it rescans, so reuse the decode until the file changes.
let t3UsageMemo = null;

export function readT3Usage(settings = {}, force = false) {
  const resolver = buildAccountResolver(settings);
  const file = path.join(config.t3Userdata, "usage-scan-cache-v17.json");
  const info = stat(file);
  const memoKey = info ? `${info.mtimeMs}:${info.size}:${resolver.signature}` : null;
  let value;
  if (memoKey && t3UsageMemo?.key === memoKey) {
    value = t3UsageMemo.value;
  } else {
    value = decodeT3Usage(file, info, resolver);
    t3UsageMemo = memoKey && value.source.status !== "failed" ? { key: memoKey, value } : null;
  }
  const multiAccountProviders = new Set(resolver.multiAccountProviders);
  if ((value.claudeDirs?.length ?? 0) > 1) multiAccountProviders.add("claude");
  if (!value.scanned) return { ...value, multiAccountProviders };
  // T3 saves this cache only now and then, but its Usage page reads live transcripts.
  // Read what Claude wrote after the last save so both show the same numbers.
  const unsaved = readUnsavedClaudeUsage(value.scanned, value.claudeDirs, info.mtimeMs, resolver, force);
  if (unsaved.length === 0) return { ...value, multiAccountProviders };
  return {
    records: [...value.records, ...unsaved],
    multiAccountProviders,
    source: { ...value.source, records: value.source.records + unsaved.length, unsavedRecords: unsaved.length },
  };
}

const claudeTailMemo = new Map();
let claudeListing = null;
const LISTING_TTL_MS = 15000;

function readUnsavedClaudeUsage(scanned, dirs, savedAtMs, resolver, force = false) {
  const records = [];
  const live = new Set();
  for (const [file, scannedSize] of scanned) {
    const info = stat(file);
    if (info && info.size > scannedSize) {
      live.add(file);
      const account = resolver.resolve("claude", file);
      for (const record of claudeTail(file, scannedSize, info.size)) {
        records.push(account ? { ...record, ...account } : record);
      }
    }
  }
  // New transcripts started after the save are not in the cache at all.
  for (const file of listClaudeTranscripts(dirs, force)) {
    if (scanned.has(file)) continue;
    const info = stat(file);
    if (!info || info.mtimeMs < savedAtMs - 60000) continue;
    live.add(file);
    const account = resolver.resolve("claude", file);
    for (const record of claudeTail(file, 0, info.size)) {
      records.push(account ? { ...record, ...account } : record);
    }
  }
  for (const file of claudeTailMemo.keys()) if (!live.has(file)) claudeTailMemo.delete(file);
  return records;
}

function listClaudeTranscripts(dirs, force = false) {
  const key = dirs.join("\0");
  if (!force && claudeListing?.key === key && Date.now() - claudeListing.at < LISTING_TTL_MS) return claudeListing.files;
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) if (String(name).endsWith(".jsonl")) files.push(path.join(dir, String(name)));
  }
  claudeListing = { key, at: Date.now(), files };
  return files;
}

function claudeTail(file, from, size) {
  const held = claudeTailMemo.get(file);
  if (held?.from === from && held.size === size) return held.records;
  let text;
  try {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - from);
      fs.readSync(handle, buffer, 0, buffer.length, from);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return [];
  }
  const lines = text.split("\n");
  // A half-written last line is read again once Claude finishes it.
  lines.pop();
  const records = [];
  for (const line of lines) if (line.includes('"usage"')) records.push(...parseClaudeLine(line));
  claudeTailMemo.set(file, { from, size, records });
  return records;
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Mirrors T3's parseClaudeLine (apps/server/src/provider/Drivers/claudeUsage.ts).
function parseClaudeLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  const message = record?.message;
  const usage = message?.usage;
  if (record?.type !== "assistant" || typeof usage !== "object" || usage === null) return [];
  const timestampMs = Date.parse(record.timestamp);
  const model = typeof message.model === "string" ? message.model : "";
  if (!Number.isFinite(timestampMs) || !model || model === "<synthetic>") return [];
  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId = typeof record.requestId === "string" ? record.requestId : null;
  const dedupeKey = messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const speed = usage.speed === "fast" ? "fast" : "standard";
  const toRecord = (source, recordModel, key, reportedCostUsd) => ({
    provider: "claude",
    timestampMs,
    model: recordModel,
    sessionId,
    totals: {
      uncachedInputTokens: tokenCount(source.input_tokens),
      cachedInputTokens: tokenCount(source.cache_read_input_tokens),
      cacheCreationTokens: tokenCount(source.cache_creation_input_tokens),
      outputTokens: tokenCount(source.output_tokens),
      reasoningTokens: 0,
    },
    cacheCreation1hTokens: tokenCount(source.cache_creation?.ephemeral_1h_input_tokens),
    reportedCostUsd,
    speed,
    dedupeKey: key,
  });
  const cost = typeof record.costUSD === "number" && Number.isFinite(record.costUSD) ? record.costUSD : null;
  const records = [toRecord(usage, model, dedupeKey, cost)];
  // Advisor calls run on another model and appear only in `iterations`.
  for (const [index, iteration] of (Array.isArray(usage.iterations) ? usage.iterations : []).entries()) {
    if (iteration?.type !== "advisor_message") continue;
    const advisorModel = typeof iteration.model === "string" ? iteration.model : "";
    if (!advisorModel || advisorModel === "<synthetic>") continue;
    records.push(toRecord(iteration, advisorModel, dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`, null));
  }
  return records;
}

function decodeT3Usage(file, info, resolver) {
  const document = readJson(file);
  if (!document || !Array.isArray(document.models) || !Array.isArray(document.sessions)) {
    return {
      records: [],
      source: {
        id: "t3-cache",
        label: "T3 supported providers",
        status: "failed",
        message: info ? "The T3 usage cache could not be decoded." : "T3 usage cache not found. Open T3 Usage once to populate it.",
        updatedAt: info?.mtime.toISOString() ?? null,
      },
    };
  }
  const records = [];
  const providers = {};
  const scanned = new Map();
  const claudeDirs = Object.entries(document.sources ?? {})
    .filter(([key, value]) => key.startsWith("claude\0") && typeof value?.dir === "string")
    .map(([, value]) => value.dir);
  let malformedFiles = 0;
  for (const [entryFile, entry] of Object.entries(document.files ?? {})) {
    if (!entry || !Array.isArray(entry.r) || !Array.isArray(entry.t) || !entry.p) {
      malformedFiles += 1;
      continue;
    }
    const provider = entry.p;
    if (provider === "claude" && Number.isFinite(entry.s)) scanned.set(entryFile, entry.s);
    const account = resolver?.resolve(provider, entryFile) ?? null;
    providers[provider] ??= { files: 0, records: 0 };
    providers[provider].files += 1;
    for (const row of [...entry.r, ...entry.t]) {
      const record = decodeCacheRecord(row, provider, document.models, document.sessions, document.version);
      if (record) records.push(account ? { ...record, ...account } : record);
    }
    providers[provider].records += entry.r.length + entry.t.length;
  }
  return {
    records,
    scanned,
    claudeDirs,
    source: {
      id: "t3-cache",
      label: "T3 supported providers",
      status: malformedFiles > 0 ? "partial" : "ok",
      message: malformedFiles > 0 ? `${malformedFiles} cache entries were skipped.` : null,
      updatedAt: info?.mtime.toISOString() ?? null,
      files: Object.keys(document.files ?? {}).length,
      records: records.length,
      providers,
    },
  };
}

function zaiInstanceIds(settings) {
  const ids = new Set();
  for (const [id, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (instance?.driver === "acpRegistry" && instance?.config?.agentId === "glm-acp-agent") ids.add(id);
  }
  if (ids.size === 0) ids.add("acpRegistry_glm_agent");
  return ids;
}

function antigravityRateModel(model) {
  const base = model.replace(/-(?:extra-low|low|medium|high|tiered|control|thinking|agent)$/, "");
  const normalized = /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
    ? "gemini-3.5-flash"
    : model === "gemini-3.7-flash-safety-le"
      ? "gemini-3.7-flash"
      : base === "gemini-3-flash"
        ? "gemini-3-flash-preview"
        : base;
  return normalized.startsWith("gemini-") ? `gemini/${normalized}` : normalized;
}

function openCodeRateModel(model) {
  if (model.startsWith("opencode-go/")) return `opencode_go/${model.slice("opencode-go/".length)}`;
  return undefined;
}

export function readT3StateUsage(settings, sinceMs = 0, { skipProviders = new Set() } = {}) {
  const file = path.join(config.t3Userdata, "statev2.sqlite");
  const info = stat(file);
  if (!info) {
    return {
      records: [],
      sources: [
        { id: "t3-state", label: "Z.ai / Antigravity / OpenCode", status: "missing", message: "T3 state database not found.", updatedAt: null },
      ],
    };
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`
      SELECT t.provider_turn_id AS turn_id,
             t.provider_thread_id AS session_id,
             COALESCE(t.completed_at, t.started_at) AS happened_at,
             t.payload_json AS turn_json,
             r.payload_json AS run_json,
             th.driver AS driver,
             th.provider_instance_id AS instance_id
      FROM orchestration_v2_projection_provider_turns t
      JOIN orchestration_v2_projection_provider_threads th
        ON th.provider_thread_id = t.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts a
        ON a.attempt_id = t.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.run_id = a.run_id
      WHERE th.driver IN ('acpRegistry', 'antigravity', 'opencode')
        AND json_extract(t.payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
        AND COALESCE(t.completed_at, t.started_at) >= ?
    `).all(new Date(Math.max(0, sinceMs - 36 * 3600000)).toISOString());
    const zaiInstances = zaiInstanceIds(settings);
    const records = [];
    const counts = {
      zai: { label: "Z.ai / GLM", records: 0, skipped: 0 },
      antigravity: { label: "Antigravity", records: 0, skipped: 0 },
      opencode: { label: "OpenCode", records: 0, skipped: 0 },
    };
    for (const row of rows) {
      let provider = null;
      if (row.driver === "acpRegistry") {
        if (zaiInstances.has(row.instance_id)) provider = "zai";
      } else if (row.driver === "antigravity" && !skipProviders.has("antigravity")) {
        provider = "antigravity";
      } else if (row.driver === "opencode" && !skipProviders.has("opencode")) {
        provider = "opencode";
      }
      if (!provider) continue;

      const turn = JSON.parse(row.turn_json);
      const run = row.run_json ? JSON.parse(row.run_json) : {};
      const usage = turn.turnTokenUsage;
      const model = run.modelSelection?.model;
      const happenedAt = timestamp(row.happened_at);
      if (!model || !happenedAt || !Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) {
        counts[provider].skipped += 1;
        continue;
      }
      const cached = Math.max(0, number(usage.cachedInputTokens));
      const created = Math.max(0, number(usage.cacheCreationTokens));
      const accountLabel = settings.providerInstances?.[row.instance_id]?.displayName || counts[provider].label;
      const rateModel =
        provider === "zai"
          ? `zai/${model}`
          : provider === "antigravity"
            ? antigravityRateModel(model)
            : openCodeRateModel(model);
      records.push({
        provider,
        accountId: row.instance_id,
        accountLabel,
        timestampMs: happenedAt,
        model,
        rateModel,
        sessionId: row.session_id,
        totals: {
          uncachedInputTokens: Math.max(0, usage.inputTokens - cached - created),
          cachedInputTokens: cached,
          cacheCreationTokens: created,
          outputTokens: Math.max(0, usage.outputTokens),
          reasoningTokens: Math.max(0, number(usage.reasoningTokens)),
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: `${provider}:${row.turn_id}`,
      });
      counts[provider].records += 1;
    }
    const sources = Object.entries(counts)
      .filter(([id, entry]) => id === "zai" || entry.records > 0 || entry.skipped > 0)
      .map(([id, entry]) => ({
        id,
        label: entry.label,
        status: entry.skipped > 0 ? "partial" : "ok",
        message: entry.skipped > 0 ? `${entry.skipped} recorded turns lacked a model or complete counters.` : null,
        updatedAt: info.mtime.toISOString(),
        records: entry.records,
      }));
    return { records, sources };
  } catch (error) {
    return {
      records: [],
      sources: [
        { id: "t3-state", label: "Z.ai / Antigravity / OpenCode", status: "failed", message: safeError(error), updatedAt: info.mtime.toISOString() },
      ],
    };
  } finally {
    db?.close();
  }
}

// Kimi Code keeps each session's log at <workspace>/<session>/agents/main/wire.jsonl; probing that
// path skips walking ~2,000 file-history and log folders one await at a time.
async function listKimiCodeWireFiles(root, sinceMs, output, errors) {
  const listDirs = async (dir) =>
    (await fs.promises.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => path.join(dir, entry.name));
  let workspaces;
  try {
    workspaces = await listDirs(root);
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`${root}: ${safeError(error)}`);
    return;
  }
  const sessions = (await Promise.all(workspaces.map((dir) => listDirs(dir).catch(() => [])))).flat();
  const found = await Promise.all(sessions.map(async (session) => {
    const file = path.join(session, "agents", "main", "wire.jsonl");
    const info = await fs.promises.stat(file).catch(() => null);
    return info?.isFile() && info.mtimeMs >= sinceMs - 36 * 3600000 ? file : null;
  }));
  for (const file of found) if (file) output.push(file);
}

async function listWireFiles(root, sinceMs, output, errors) {
  if (root === config.kimiSessions) return listKimiCodeWireFiles(root, sinceMs, output, errors);
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`${root}: ${safeError(error)}`);
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await listWireFiles(file, sinceMs, output, errors);
    else if (entry.isFile() && entry.name === "wire.jsonl") {
      const info = await fs.promises.stat(file).catch(() => null);
      if (info && info.mtimeMs >= sinceMs - 36 * 3600000) output.push(file);
    }
  }
}

// Kimi Code logs models as `kimi-code/<id>` (e.g. `kimi-code/k3.1-pro`); the shared rate
// table prices the same models under Moonshot's first-party names (`moonshot/kimi-k3.1-pro`).
function kimiRateModel(model) {
  const id = model.startsWith("kimi-code/") ? model.slice("kimi-code/".length) : model;
  if (id.includes("/")) return undefined;
  return `moonshot/${id.startsWith("kimi-") ? id : `kimi-${id}`}`;
}

async function readKimiFile(file, root, sinceMs, records) {
  const relative = path.relative(root, file).split(path.sep);
  const sessionId = relative.slice(0, 2).join("/");
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.includes('"usage.record"') || !line.includes('"turn"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "usage.record" || event.usageScope !== "turn") continue;
      const happenedAt = timestamp(event.time);
      if (!happenedAt || happenedAt < sinceMs || !event.model) continue;
      const usage = event.usage ?? {};
      records.push({
        provider: "kimi",
        timestampMs: happenedAt,
        model: event.model,
        rateModel: kimiRateModel(event.model),
        sessionId,
        totals: {
          uncachedInputTokens: Math.max(0, number(usage.inputOther)),
          cachedInputTokens: Math.max(0, number(usage.inputCacheRead)),
          cacheCreationTokens: Math.max(0, number(usage.inputCacheCreation)),
          outputTokens: Math.max(0, number(usage.output)),
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        // Keyed by session, not absolute path, so a log copied between Kimi homes is counted once.
        dedupeKey: `kimi:${sessionId}:${lineNumber}`,
      });
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

// Kimi appends to its session logs; a file whose size and mtime are unchanged has the same records.
const kimiFileMemo = new Map();

export async function readKimiUsage(sinceMs) {
  const roots = [...new Set([config.kimiSessions, config.legacyKimiSessions])];
  const files = [];
  const discoveryErrors = [];
  for (const root of roots) await listWireFiles(root, sinceMs, files, discoveryErrors);
  const records = [];
  const errors = [...discoveryErrors];
  const listed = new Set(files);
  for (const held of kimiFileMemo.keys()) if (!listed.has(held) && !fs.existsSync(held)) kimiFileMemo.delete(held);
  for (const file of files) {
    const root = roots.find((candidate) => file.startsWith(candidate + path.sep)) ?? roots[0];
    try {
      const info = stat(file);
      const key = info ? `${info.mtimeMs}:${info.size}` : null;
      let held = kimiFileMemo.get(file);
      if (!key || held?.key !== key) {
        const parsed = [];
        await readKimiFile(file, root, 0, parsed);
        held = { key, records: parsed };
        if (key) kimiFileMemo.set(file, held);
      }
      for (const record of held.records) if (record.timestampMs >= sinceMs) records.push(record);
    } catch (error) {
      errors.push(`${path.basename(path.dirname(path.dirname(file)))}: ${safeError(error)}`);
    }
  }
  const latest = files.map((file) => stat(file)?.mtimeMs ?? 0).sort((a, b) => b - a)[0] ?? 0;
  return {
    records,
    source: {
      id: "kimi",
      label: "Kimi Code",
      status: errors.length > 0 ? "partial" : files.length === 0 ? "missing" : "ok",
      message: errors.length > 0 ? errors[0] : files.length === 0 ? "No Kimi session logs found in the selected period." : null,
      updatedAt: latest > 0 ? new Date(latest).toISOString() : null,
      files: files.length,
      records: records.length,
    },
  };
}
