import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readKimiUsage, readPricing, readT3Settings, readT3Usage, readZaiUsage } from "./collectors.js";
import { readLimits } from "./limits.js";
import { aggregateRecords } from "./usage.js";
import { safeError } from "./util.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function windowFrom(url) {
  const untilMs = Math.min(Number(url.searchParams.get("until")) || Date.now(), Date.now() + 300000);
  const sinceMs = Number(url.searchParams.get("since")) || untilMs - 7 * 86400000;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs || untilMs - sinceMs > 92 * 86400000) {
    throw new Error("Invalid usage window. Choose a range of 92 days or less.");
  }
  return { sinceMs, untilMs };
}

async function dashboard(url) {
  const { sinceMs, untilMs } = windowFrom(url);
  const timeZone = url.searchParams.get("timeZone") || "UTC";
  const force = url.searchParams.get("refresh") === "1";
  const settings = readT3Settings();
  const pricing = readPricing(settings);
  const t3 = readT3Usage();
  const zai = readZaiUsage(settings);
  const [kimi, limits] = await Promise.all([readKimiUsage(sinceMs), readLimits(settings, force)]);
  const sources = [t3.source, zai.source, kimi.source];
  const records = [...t3.records, ...zai.records, ...kimi.records];
  const usage = aggregateRecords(records, {
    sinceMs,
    untilMs,
    timeZone,
    rates: pricing.rates,
    overrides: pricing.overrides,
    aliases: pricing.aliases,
    modelFilter: pricing.modelFilter,
  });
  return {
    ...usage,
    limits,
    sources,
    meta: {
      readAt: new Date().toISOString(),
      sinceMs,
      untilMs,
      timeZone,
      pricingFetchedAt: pricing.fetchedAt,
      liveLimits: process.env.DASHBOARD_LIVE_LIMITS !== "0",
      recordsScanned: records.length,
    },
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (url.pathname === "/api/dashboard") return json(response, 200, await dashboard(url));
    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found." });
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(publicDir, `.${relative}`);
    if (!file.startsWith(publicDir + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      return json(response, 404, { error: "Not found." });
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(file).pipe(response);
  } catch (error) {
    json(response, 500, { error: safeError(error) });
  }
});

const portArgument = process.argv.indexOf("--port");
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT ?? 4789);
const host = "127.0.0.1";
server.listen(Number.isInteger(port) ? port : 4789, host, () => {
  const address = server.address();
  console.log(`Usage dashboard: http://${host}:${typeof address === "object" && address ? address.port : port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
