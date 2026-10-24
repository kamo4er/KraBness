# KraBness: notes for coding agents

KraBness is a self-hosted harness for AI coding agents: the agent runs on a Windows PC, the web UI and the Android app watch and control the same live session. Two engines: opencode (any model) and the official Claude Code CLI.

You may be running **inside KraBness itself** (the hub started you, and the user is probably typing on a phone). Keep answers short, put details in files.

## If you run inside the hub

- Do not kill the hub on its port (7420 by default): no `taskkill` by process name, no second `npm run hub`. It kills your own session.
- The hub runs under the supervisor `scripts/hub-service.ps1`. To restart it (needed after changes in `apps/hub`), ask the user first, then `POST /api/hub/restart` with `{"delaySec":40}` and finish your answer: the session drops and resumes after the restart. If `GET /api/hub` says `supervised: false`, only the user can restart it.
- Never use `taskkill /T`: it matches children by parent PID only, and PIDs are reused. Use `killTree` / `killPidTree` from `apps/hub/src/proc.ts`.
- Logs: `data/logs/hub.log` (hub), `data/logs/supervisor.log` (supervisor, updates).
- Changes in `apps/web` go live after `npm run web:build` without a restart. Changes in `apps/hub` need a restart.

## Architecture

```
 Android app (apps/mobile) ┐              ┌─► OpencodeEngine → opencode serve (v1 API + SSE)
 web UI (apps/web)         ├─ WS/REST ─► Hub ┤
 (over Tailscale)          ┘   apps/hub      └─► ClaudeEngine → `claude -p` stream-json, one process per session
                                  │
                                  ├─ SQLite: sessions, event journal (seq, replay), devices, files
                                  └─ hub MCP /mcp/<secret>/<scope>: approvals, send_file_to_user
```

- `packages/protocol`: event types and the `applyEvent` / `applyDelta` reducer shared by all clients.
- `packages/client`: `HubClient` (WebSocket with reconnect and replay from `lastSeq`, REST). Works in the browser and in React Native.
- `apps/hub/src`:
  - `hub.ts` assembles everything;
  - `server.ts` REST and WS;
  - `sessions.ts` journal and fan-out;
  - `engines/*` the two engines;
  - `updates.ts` GitHub Releases;
  - `lang.ts` interface language.
- `apps/web/src`: React + Vite.
- `apps/mobile`: Expo (see `apps/mobile/AGENTS.md`).
- Updates:
  1. The hub checks GitHub Releases daily and downloads a release to `data/updates/stage`.
  2. The supervisor runs `scripts/apply-update.mjs` between hub runs: backup, swap, `npm ci`, web build.
  3. If the new hub exits right after start, the supervisor rolls back.
- Security:
  - localhost is trusted, but cross-site requests are rejected (`crossSite` in `server.ts`);
  - other devices use a device token from pairing;
  - agents only work inside the allowed `roots`, checked via realpath.

## Run and check

```
npm run hub                 # by hand; UI at http://127.0.0.1:7420
scripts\hub-service.ps1     # under the supervisor (restart and updates from the UI)
npm run web:dev             # UI with hot reload on :5173 (the hub must be running)
npm run typecheck
npm test                    # unit tests (fixtures of real opencode and claude streams)
npm run test:integration    # live: real opencode and claude, uses a little quota
```

Tests start their own hub on a random port with a temporary config. Provider tests must use an isolated opencode (`XDG_*_HOME` in a temp folder), skill tests a temporary `skillsDir`. Otherwise they touch the user's real keys and skills.

## Conventions

- TypeScript strict, ESM, imports with `.ts`. Code comments are in Russian, short, only about the non-obvious.
- Interface language: every visible string is a pair, right in the code:
  - clients: `t("рус", "eng")`, `tn(n, [3 forms], [2 forms])`;
  - hub: `L("рус", "eng")`.

  Module-level constants with text must be functions. Do not name a local variable `t`.
- MCP tool descriptions are always in English.
- New behaviour gets a test; engine protocol changes get fixtures from a real stream.
- Never commit `data/`, `config/kamharn.json`, `.env`, `apps/mobile/credentials/`.

## Windows pitfalls

- PowerShell 5 reads `.ps1` without a BOM as ANSI: keep scripts ASCII (English text).
- Background scripts (supervisor, watchdog, autostart) run via `conhost.exe --headless powershell.exe ...`. With Windows Terminal as the default terminal, `-WindowStyle Hidden` does not hide the window.
- opencode 1.19.x: use the **v1 API**. The v2 prompt endpoint accepts a prompt but does not start the agent.
- `claude --bare` does not use the subscription: do not enable it.
- Android build: ninja from CMake 3.22.1 can't handle paths over 260 characters, CMake 3.31+ from the SDK is needed (`plugins/with-local-toolchain.js`).
