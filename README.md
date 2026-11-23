# T3 Code usage dashboard

A local, read-only dashboard for AI coding usage, cost and plan limits, styled after T3 Code's Usage screen.

It combines:

- **T3 Code providers** (Claude, Codex, OpenCode, …) from T3's usage scan cache and cached plan limits
- **Z.ai / GLM** usage from T3's database, and live limits using the key you saved in T3 (or `Z_AI_API_KEY`)
- **Kimi Code** usage from its session logs, priced at Moonshot API rates, and live limits from Kimi's stored sign-in

Costs are API-price estimates from T3's cached rate table (plus any price overrides and model aliases set in T3), not your subscription bill.

## Run

Requires Node 22.13 or later.

```bash
npm install
npm start          # http://127.0.0.1:4789
```

Set `PORT` or pass `--port` to change the port. The server only listens on `127.0.0.1`.

## Data and safety

- Provider and T3 data are only read, never written.
- The dashboard keeps its own state (the last good live limit readings) in `~/Library/Application Support/usage-dashboard` (override with `DASHBOARD_STATE_DIR`).
- Kimi's access token lasts 15 minutes and is renewed only when Kimi is used. When it has lapsed, the Limits view shows the last good reading, marked as such.

| Variable | Default | Purpose |
|---|---|---|
| `T3CODE_HOME` | `~/.t3` | T3 Code data directory |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi Code data directory |
| `DASHBOARD_LIVE_LIMITS` | on | Set to `0` to skip live Z.ai and Kimi limit lookups |
| `DASHBOARD_STATE_DIR` | `~/Library/Application Support/usage-dashboard` | The dashboard's own state |

## Run at login (macOS)

Create `~/Library/LaunchAgents/local.usage-dashboard.plist` with `ProgramArguments` set to your `node` binary and `src/server.js`, `WorkingDirectory` set to this checkout, and `RunAtLoad` and `KeepAlive` set to `true`. Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.usage-dashboard.plist
launchctl kickstart -k gui/$(id -u)/local.usage-dashboard   # restart after changes
```
