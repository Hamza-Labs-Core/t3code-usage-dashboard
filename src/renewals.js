import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { isoDate, readJson } from "./util.js";

const CADENCE_MONTHS = { monthly: 1, quarterly: 3, annual: 12, none: 0 };
const VALID_CADENCES = new Set(Object.keys(CADENCE_MONTHS));
const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const BILLING_LINKS = {
  claude: { label: "Claude billing", url: "https://claude.ai/settings/billing" },
  antigravity: { label: "Google One", url: "https://one.google.com/settings" },
  codex: { label: "ChatGPT billing", url: "https://chatgpt.com/#settings/Subscription" },
  cursor: { label: "Cursor billing", url: "https://cursor.com/dashboard?tab=billing" },
};

const renewalsFile = () => path.join(config.stateDir, "renewals.json");

function readSavedRenewals() {
  const data = readJson(renewalsFile(), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
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
  for (let k = 1; k < 600; k++) {
    const next = addMonthsClamped(parsed.year, parsed.month - 1, parsed.day, k * step);
    const ymd = formatYmd(next.year, next.monthIndex + 1, next.day);
    if (ymd >= today) return ymd;
  }
  return anchorYmd;
}

function nextUtcCycleIso(anchorIso, stepMonths, nowMs = Date.now()) {
  const start = new Date(anchorIso);
  if (!Number.isFinite(start.getTime())) return null;
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth();
  const d0 = start.getUTCDate();
  const h = start.getUTCHours();
  const min = start.getUTCMinutes();
  const sec = start.getUTCSeconds();
  for (let k = 1; k < 600; k++) {
    const next = addMonthsClamped(y0, m0, d0, k * stepMonths);
    const ms = Date.UTC(next.year, next.monthIndex, next.day, h, min, sec);
    if (ms > nowMs) return new Date(ms).toISOString();
  }
  return null;
}

function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === "~") return config.home;
  if (trimmed.startsWith("~/")) return path.join(config.home, trimmed.slice(2));
  return path.resolve(trimmed);
}

function instanceEnvValue(instance, name) {
  const entries = Array.isArray(instance?.environment) ? instance.environment : [];
  for (const entry of entries) {
    if (entry?.name === name && typeof entry.value === "string" && entry.valueRedacted !== true) {
      return entry.value;
    }
  }
  return null;
}

function claudeAccountMetadata(account, settings) {
  const instance = settings?.providerInstances?.[account.instanceId];
  const customDir =
    expandHome(instance?.config?.homePath) ??
    expandHome(instanceEnvValue(instance, "CLAUDE_CONFIG_DIR"));
  const candidates = customDir
    ? [path.join(customDir, ".claude.json")]
    : [path.join(config.home, ".claude.json"), path.join(config.home, ".claude", ".claude.json")];
  for (const file of candidates) {
    const doc = readJson(file);
    const oauth = doc?.oauthAccount;
    if (!oauth || typeof oauth !== "object") continue;
    const createdAt = isoDate(oauth.subscriptionCreatedAt);
    if (!createdAt) continue;
    return {
      createdAt,
      billingType: typeof oauth.billingType === "string" ? oauth.billingType : null,
      plan: typeof oauth.planDisplayName === "string" ? oauth.planDisplayName : null,
    };
  }
  return null;
}

function codexActiveUntil(account, settings) {
  const instance = settings?.providerInstances?.[account.instanceId];
  const codexHome =
    expandHome(instanceEnvValue(instance, "CODEX_HOME")) ??
    expandHome(process.env.CODEX_HOME) ??
    path.join(config.home, ".codex");
  const auth = readJson(path.join(codexHome, "auth.json"));
  const idToken = auth?.tokens?.id_token;
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const until = isoDate(payload?.["https://api.openai.com/auth"]?.chatgpt_subscription_active_until);
    return until && Date.parse(until) > Date.now() ? until : null;
  } catch {
    return null;
  }
}

function detectRenewal(account, settings, nowMs) {
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
    const until = codexActiveUntil(account, settings);
    if (until) {
      return {
        nextAt: until,
        cadence: "monthly",
        source: "reported",
        estimated: false,
        basis: "Reported by Codex subscription token",
      };
    }
  }
  if (account.provider === "claude") {
    const meta = claudeAccountMetadata(account, settings);
    if (meta?.createdAt) {
      const nextAt = nextUtcCycleIso(meta.createdAt, 1, nowMs);
      if (nextAt) {
        return {
          nextAt,
          cadence: "monthly",
          source: "estimated",
          estimated: true,
          createdAt: meta.createdAt,
          basis: `Estimated monthly cycle from signup (${meta.createdAt.slice(0, 10)})`,
        };
      }
    }
  }
  return null;
}

export function attachRenewals(accounts, settings) {
  const saved = readSavedRenewals();
  const now = new Date();
  const nowMs = now.getTime();
  return accounts.map((account) => {
    const externalUsage = account.externalUsage ?? BILLING_LINKS[account.provider] ?? null;
    const override = saved[account.id];
    const detected = detectRenewal(account, settings, nowMs);
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

export function saveRenewalOverride(accountId, { date, cadence } = {}) {
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 128) {
    throw new Error("Invalid account ID.");
  }
  const store = readSavedRenewals();
  if (date === null || date === undefined || date === "") {
    delete store[accountId];
    writeSavedRenewals(store);
    return store;
  }
  if (!parseYmd(date)) {
    throw new Error("Renewal date must be a valid YYYY-MM-DD date.");
  }
  const normalizedCadence = cadence ?? "monthly";
  if (!VALID_CADENCES.has(normalizedCadence)) {
    throw new Error("Cadence must be monthly, quarterly, annual, or none.");
  }
  store[accountId] = { date: date.trim(), cadence: normalizedCadence };
  writeSavedRenewals(store);
  return store;
}
