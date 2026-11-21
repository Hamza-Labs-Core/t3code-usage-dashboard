import os from "node:os";
import path from "node:path";

const home = os.homedir();
const t3Home = path.resolve(process.env.T3CODE_HOME ?? path.join(home, ".t3"));
const kimiHome = path.resolve(process.env.KIMI_CODE_HOME ?? path.join(home, ".kimi-code"));

export const config = {
  home,
  t3Home,
  t3Userdata: path.join(t3Home, "userdata"),
  t3Cache: path.join(t3Home, "caches"),
  kimiHome,
  kimiSessions: path.join(kimiHome, "sessions"),
  legacyKimiSessions: path.join(home, ".kimi", "sessions"),
  liveLimits: process.env.DASHBOARD_LIVE_LIMITS !== "0",
  // The dashboard's own state; never inside a provider's or T3's directories.
  stateDir: path.resolve(process.env.DASHBOARD_STATE_DIR ?? path.join(home, "Library", "Application Support", "usage-dashboard")),
};
