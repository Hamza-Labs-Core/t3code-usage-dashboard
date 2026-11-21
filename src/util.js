import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

export function isoDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

export function absolute(file) {
  return path.isAbsolute(file) ? file : path.resolve(file);
}
