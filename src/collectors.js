import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
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

// T3 rewrites its 46 MB usage cache only when it rescans, so reuse the decode until the file changes.
let t3UsageMemo = null;

export function readT3Usage() {
  const file = path.join(config.t3Userdata, "usage-scan-cache-v17.json");
  const info = stat(file);
  const memoKey = info ? `${info.mtimeMs}:${info.size}` : null;
  if (memoKey && t3UsageMemo?.key === memoKey) return t3UsageMemo.value;
  const value = decodeT3Usage(file, info);
  t3UsageMemo = memoKey && value.source.status !== "failed" ? { key: memoKey, value } : null;
  return value;
}

function decodeT3Usage(file, info) {
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
  let malformedFiles = 0;
  for (const entry of Object.values(document.files ?? {})) {
    if (!entry || !Array.isArray(entry.r) || !Array.isArray(entry.t) || !entry.p) {
      malformedFiles += 1;
      continue;
    }
    const provider = entry.p;
    providers[provider] ??= { files: 0, records: 0 };
    providers[provider].files += 1;
    for (const row of [...entry.r, ...entry.t]) {
      const record = decodeCacheRecord(row, provider, document.models, document.sessions, document.version);
      if (record) records.push(record);
    }
    providers[provider].records += entry.r.length + entry.t.length;
  }
  return {
    records,
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

export function readZaiUsage(settings, sinceMs = 0) {
  const file = path.join(config.t3Userdata, "statev2.sqlite");
  const info = stat(file);
  if (!info) {
    return {
      records: [],
      source: { id: "zai", label: "Z.ai / GLM", status: "missing", message: "T3 state database not found.", updatedAt: null },
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
             th.provider_instance_id AS instance_id
      FROM orchestration_v2_projection_provider_turns t
      JOIN orchestration_v2_projection_provider_threads th
        ON th.provider_thread_id = t.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts a
        ON a.attempt_id = t.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.run_id = a.run_id
      WHERE th.driver = 'acpRegistry'
        AND json_extract(t.payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
        AND COALESCE(t.completed_at, t.started_at) >= ?
    `).all(new Date(Math.max(0, sinceMs - 36 * 3600000)).toISOString());
    const instances = zaiInstanceIds(settings);
    const records = [];
    let skipped = 0;
    for (const row of rows) {
      if (!instances.has(row.instance_id)) continue;
      const turn = JSON.parse(row.turn_json);
      const run = row.run_json ? JSON.parse(row.run_json) : {};
      const usage = turn.turnTokenUsage;
      const model = run.modelSelection?.model;
      const happenedAt = timestamp(row.happened_at);
      if (!model || !happenedAt || !Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) {
        skipped += 1;
        continue;
      }
      const cached = Math.max(0, number(usage.cachedInputTokens));
      const created = Math.max(0, number(usage.cacheCreationTokens));
      records.push({
        provider: "zai",
        timestampMs: happenedAt,
        model,
        rateModel: `zai/${model}`,
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
        dedupeKey: `zai:${row.turn_id}`,
      });
    }
    return {
      records,
      source: {
        id: "zai",
        label: "Z.ai / GLM",
        status: skipped > 0 ? "partial" : "ok",
        message: skipped > 0 ? `${skipped} recorded turns lacked a model or complete counters.` : null,
        updatedAt: info.mtime.toISOString(),
        records: records.length,
      },
    };
  } catch (error) {
    return {
      records: [],
      source: { id: "zai", label: "Z.ai / GLM", status: "failed", message: safeError(error), updatedAt: info.mtime.toISOString() },
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
