import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { isoDate, readJson, stat } from "./util.js";

const CADENCE_MONTHS = { monthly: 1, quarterly: 3, annual: 12, none: 0 };
const VALID_CADENCES = new Set(Object.keys(CADENCE_MONTHS));
const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACCOUNT_ID_PATTERN = /^[\w:.-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const BILLING_LINKS = {
  claude: { label: "Claude billing", url: "https://claude.ai/settings/billing" },
  antigravity: { label: "Google One", url: "https://one.google.com/settings" },
  codex: { label: "ChatGPT billing", url: "https://chatgpt.com/#settings/Subscription" },
  cursor: { label: "Cursor billing", url: "https://cursor.com/dashboard?tab=billing" },
};

export class RenewalValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const renewalsFile = () => path.join(config.stateDir, "renewals.json");

function readSavedRenewals() {
  const raw = readJson(renewalsFile(), null);
  const store = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return store;
  for (const [key, value] of Object.entries(raw)) {
    if (!FORBIDDEN_KEYS.has(key) && ACCOUNT_ID_PATTERN.test(key)) store[key] = value;
  }
  return store;
}

function writeSavedRenewals(store) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const temporary = `${renewalsFile()}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.renameSync(temporary, renewalsFile());
}

function parseYmd(value) {
  if (typeof value !== "string") return null;
  const match = YMD_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonthsClamped(year, monthIndex, day, deltaMonths) {
  const total = monthIndex + deltaMonths;
  const nextYear = year + Math.floor(total / 12);
  const nextMonthIndex = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate();
  return { year: nextYear, monthIndex: nextMonthIndex, day: Math.min(day, lastDay) };
}

function todayLocalYmd(now = new Date()) {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function nextCalendarDate(anchorYmd, cadence, now = new Date()) {
  const parsed = parseYmd(anchorYmd);
  if (!parsed) return null;
  const step = CADENCE_MONTHS[cadence] ?? 0;
  const today = todayLocalYmd(now);
  if (step <= 0 || anchorYmd >= today) return anchorYmd;
  const monthsDiff = (now.getFullYear() - parsed.year) * 12 + (now.getMonth() + 1 - parsed.month);
  let k = Math.max(1, Math.floor(monthsDiff / step));
  while (true) {
    const next = addMonthsClamped(parsed.year, parsed.month - 1, parsed.day, k * step);
    const ymd = formatYmd(next.year, next.monthIndex + 1, next.day);
    if (ymd >= today) return ymd;
    k += 1;
  }
}

function nextUtcCycleIso(anchorIso, stepMonths, nowMs = Date.now()) {
  const start = new Date(anchorIso);
  if (!Number.isFinite(start.getTime())) return null;
  const now = new Date(nowMs);
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth();
  const d0 = start.getUTCDate();
  const h = start.getUTCHours();
  const min = start.getUTCMinutes();
  const sec = start.getUTCSeconds();
  const monthsDiff = (now.getUTCFullYear() - y0) * 12 + (now.getUTCMonth() - m0);
  let k = Math.max(1, Math.floor(monthsDiff / stepMonths));
  while (true) {
    const next = addMonthsClamped(y0, m0, d0, k * stepMonths);
    const ms = Date.UTC(next.year, next.monthIndex, next.day, h, min, sec);
    if (ms > nowMs) return new Date(ms).toISOString();
    k += 1;
  }
}

function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === "~") return config.home;
  if (trimmed.startsWith("~/")) return path.join(config.home, trimmed.slice(2));
  return path.resolve(trimmed);
}

function instanceEnvValue(instanceId, instance, name, readSecret) {
  const entries = Array.isArray(instance?.environment) ? instance.environment : [];
  for (const entry of entries) {
    if (entry?.name !== name) continue;
    if (entry.valueRedacted === true) return readSecret ? readSecret(instanceId, name) : null;
    if (typeof entry.value === "string" && entry.value.trim()) return entry.value;
  }
  return null;
}

// Memoize parsed provider metadata files by mtime:size so repeated requests don't re-parse large JSON.
const fileMetadataMemo = new Map();

function readMemoized(file, extract) {
  const info = stat(file);
  if (!info) {
    fileMetadataMemo.delete(file);
    return null;
  }
  const key = `${info.mtimeMs}:${info.size}`;
  const held = fileMetadataMemo.get(file);
  if (held?.key === key) return held.value;
  const value = extract(readJson(file));
  fileMetadataMemo.set(file, { key, value });
  return value;
}

function claudeSubscriptionCreatedAt(account, settings, readSecret) {
  const instance = settings?.providerInstances?.[account.instanceId];
  const isDefault = account.instanceId === "claudeAgent";
  const customDir =
    expandHome(instanceEnvValue(account.instanceId, instance, "CLAUDE_CONFIG_DIR", readSecret)) ??
    expandHome(instance?.config?.homePath) ??
    (isDefault ? expandHome(process.env.CLAUDE_CONFIG_DIR) : null);
  const candidates = customDir
    ? [path.join(customDir, ".claude.json"), path.join(customDir, ".claude", ".claude.json")]
    : isDefault
      ? [path.join(config.home, ".claude.json"), path.join(config.home, ".claude", ".claude.json")]
      : [];
  for (const file of candidates) {
    const createdAt = readMemoized(file, (doc) => isoDate(doc?.oauthAccount?.subscriptionCreatedAt) ?? null);
    if (createdAt) return createdAt;
  }
  return null;
}

function codexActiveUntil(account, settings, readSecret) {
  const instance = settings?.providerInstances?.[account.instanceId];
  const isDefault = account.instanceId === "codex";
  const codexHome =
    expandHome(instanceEnvValue(account.instanceId, instance, "CODEX_HOME", readSecret)) ??
    expandHome(instance?.config?.homePath) ??
    (isDefault ? expandHome(process.env.CODEX_HOME) ?? path.join(config.home, ".codex") : null);
  if (!codexHome) return null;
  const until = readMemoized(path.join(codexHome, "auth.json"), (auth) => {
    const idToken = auth?.tokens?.id_token;
    if (typeof idToken !== "string") return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return isoDate(payload?.["https://api.openai.com/auth"]?.chatgpt_subscription_active_until) ?? null;
    } catch {
      return null;
    }
  });
  return until && Date.parse(until) > Date.now() ? until : null;
}

function detectRenewal(account, settings, nowMs, readSecret) {
  if (account.provider === "opencode") {
    const monthly = account.windows?.find((w) => w.id === "go_monthly" && w.resetsAt);
    if (monthly?.resetsAt) {
      return {
        nextAt: monthly.resetsAt,
        cadence: "monthly",
        source: "reported",
        estimated: false,
        basis: "Reported by OpenCode Go monthly cycle",
      };
    }
  }
  if (account.provider === "kimi") {
    const monthly = account.windows?.find((w) => (w.id === "limit_month_total" || w.kind === "monthly") && w.resetsAt);
    if (monthly?.resetsAt) {
      return {
        nextAt: monthly.resetsAt,
        cadence: "monthly",
        source: "reported",
        estimated: false,
        basis: "Reported by Kimi monthly quota reset",
      };
    }
  }
  if (account.provider === "cursor") {
    const monthly = account.windows?.find((w) => w.kind === "monthly" && w.resetsAt);
    if (monthly?.resetsAt) {
      return {
        nextAt: monthly.resetsAt,
        cadence: "monthly",
        source: "reported",
        estimated: false,
        basis: "Reported by Cursor billing cycle",
      };
    }
  }
  if (account.provider === "codex") {
    const until = codexActiveUntil(account, settings, readSecret);
    if (until) {
      return {
        nextAt: until,
        cadence: null,
        verb: "Active until",
        source: "reported",
        estimated: false,
        basis: "Reported by Codex subscription token",
      };
    }
  }
  if (account.provider === "claude") {
    const createdAt = claudeSubscriptionCreatedAt(account, settings, readSecret);
    if (createdAt) {
      const nextAt = nextUtcCycleIso(createdAt, 1, nowMs);
      if (nextAt) {
        return {
          nextAt,
          cadence: "monthly",
          source: "estimated",
          estimated: true,
          createdAt,
          basis: `Estimated monthly cycle from signup (${createdAt.slice(0, 10)})`,
        };
      }
    }
  }
  return null;
}

export function attachRenewals(accounts, settings, readSecret) {
  const saved = readSavedRenewals();
  const now = new Date();
  const nowMs = now.getTime();
  return accounts.map((account) => {
    const externalUsage = account.externalUsage ?? BILLING_LINKS[account.provider] ?? null;
    const override = Object.hasOwn(saved, account.id) ? saved[account.id] : null;
    const detected = detectRenewal(account, settings, nowMs, readSecret);
    if (override && typeof override.date === "string" && parseYmd(override.date)) {
      const cadence = VALID_CADENCES.has(override.cadence) ? override.cadence : "monthly";
      const date = nextCalendarDate(override.date, cadence, now);
      return {
        ...account,
        externalUsage,
        renewal: {
          date,
          anchorDate: override.date,
          cadence,
          source: "manual",
          estimated: false,
          hasOverride: true,
          basis: cadence === "none" ? "Manual end date (won't auto-roll)" : `Manual (${cadence})`,
        },
      };
    }
    return {
      ...account,
      externalUsage,
      renewal: detected ? { ...detected, hasOverride: false } : null,
    };
  });
}

export function saveRenewalOverride(accountId, { date, cadence } = {}, allowedIds = null) {
  if (
    typeof accountId !== "string" ||
    FORBIDDEN_KEYS.has(accountId) ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    (allowedIds && !allowedIds.has(accountId))
  ) {
    throw new RenewalValidationError("Unknown or invalid account ID.");
  }
  const store = readSavedRenewals();
  if (date === null || date === undefined || date === "") {
    delete store[accountId];
    writeSavedRenewals(store);
    return store;
  }
  if (!parseYmd(date)) {
    throw new RenewalValidationError("Renewal date must be a valid YYYY-MM-DD date.");
  }
  const normalizedCadence = cadence ?? "monthly";
  if (!VALID_CADENCES.has(normalizedCadence)) {
    throw new RenewalValidationError("Cadence must be monthly, quarterly, annual, or none.");
  }
  store[accountId] = { date: date.trim(), cadence: normalizedCadence };
  writeSavedRenewals(store);
  return store;
}
