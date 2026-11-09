# Vendavis — Session Handoff for Claude Desktop

**Date:** 2026-11-09
**Machine:** Windows 11, project at `C:\Users\juan\dev\app\vendavis`
**Branch:** `opencode/mvp-0` — **6 commits ahead of `origin/opencode/mvp-0` (last pushed: `874c2a2`), not pushed.** Remote: `git@github.com:doppiomacchiatto/vendavis.git`. Working tree is clean (run `git log --oneline -8` for the current HEAD).

This is a short "pick up here" note. The full reference (architecture, gotchas, build details, Windows design) is in [`HANDOFF-2026-11-09.md`](HANDOFF-2026-11-09.md) — read it before changing anything non-trivial.

---

## Paste this to start the session

> I'm continuing work on Vendavis, a Tauri v2 + React + FastAPI desktop Salesforce metadata explorer, at `C:\Users\juan\dev\app\vendavis` (branch `opencode/mvp-0`). Read `HANDOFF-2026-11-09-claude-desktop.md` and then `HANDOFF-2026-11-09.md` in that folder. I'm on Windows/PowerShell. Don't push to git or change AI-provider architecture without asking. Start with the "Next steps" list.

**Claude Desktop needs file + command access to do real work** (e.g. the Filesystem and a shell MCP server, or use Claude Code in the project folder). Without that, it can only advise from pasted text.

---

## State of the project

Windows support, the release build and the error handling are all done and verified at the API level. The installed app has **not** been clicked through against a real org by the developer yet.

| Area | Status |
|---|---|
| `npm run tauri:build` | Works; produces MSI + NSIS installers in `src-tauri/target/release/bundle/` |
| NSIS install | Installed at `%LOCALAPPDATA%\Vendavis` (latest build, includes all commits) |
| Windows process cleanup | Job Object; `cargo test` passes; killing the app kills the backend |
| `sf_backend.spec` | Recreated and tracked; one-file build works |
| Expired-session errors | Clear 401 message `... run sf org login web --alias X` |
| `/api/debug-env` | Removed |
| React `ErrorBoundary` | Added (`frontend/src/components/ErrorBoundary.jsx`) |
| AI chat | Stays on the Python proxy (`backend/ai_client.py`, `/api/ai/chat`). `@opencode/sdk` was evaluated and **rejected** — it is an in-process server host, not a chat client. Do not re-add it. |

### Salesforce orgs on this machine

| Alias | Session |
|---|---|
| `vrm` (default) | Valid — API limits call verified (2 / 441,450 daily requests) |
| `gbr` | Expired — needs `sf org login web --alias gbr` |
| `san` | Expired — needs `sf org login web --alias san` |

---

## Next steps (in priority order)

1. **Click through the installed app against `vrm`.** Test every tab: FLS Explorer, Profiles & PermSets, SOQL, Apex, **Health** (the API Limits checks were the original bug report), and the footer API-limits gauge. Fix anything that fails.
2. **Force a crash to see the ErrorBoundary** (e.g. temporarily `throw` in a page component). It compiles and is wired in `main.jsx` but has never rendered.
3. **Verify the token-refresh path.** `get_org_limits` forces a refresh and retries once on a 401. This was only exercised against fully-expired orgs (error path). Test with an org whose access token is stale but whose refresh token is still valid.
4. **AI chat end to end.** Needs an API key in Settings (or `opencode.config.json`). Never tested on Windows.
5. **Run `npm run dev`** once (Vite + uvicorn + Tauri dev mode) — only the release build has been exercised.
6. **Install the MSI** (per-machine, needs admin) — only NSIS was tried.
7. **Code signing** for the Windows installers (SmartScreen warns on unsigned).
8. **Polish / cleanup** (from the main handoff): gate `frontend/src/api/client.js` request logging behind a DEBUG flag; collapse the OrgPicker debug log behind "Show details"; delete `backend/claude_client.py`; `npm audit` reports 2 vulnerabilities (1 moderate, 1 high) in `frontend/`.
9. **Decide on pushing** the 6 local commits (`git push -u origin opencode/mvp-0`) — ask the developer first.

---

## How to work on this machine

PowerShell, not bash. Rust was installed during this session, so a **new terminal** is needed for `cargo` to be on PATH; otherwise run `$env:Path += ";$env:USERPROFILE\.cargo\bin"`.

```powershell
# Dev
npm run dev                  # Vite + uvicorn(7891) + Tauri
npm run dev:backend          # backend only (cross-platform via scripts/venv-run.mjs)

# Build (also rebuilds backend/dist/sf_backend.exe first)
npm run tauri:build

# Quick checks
cd src-tauri; cargo check; cargo test            # Rust; Job Object test (Windows)
cd frontend;  npm run build                      # frontend compile check
cd backend;   .\.venv\Scripts\python.exe -c "import main"   # backend import check

# Install the NSIS build over the existing one (stop the app first)
Get-Process sf-metadata-explorer, sf_backend -ErrorAction SilentlyContinue | Stop-Process -Force
.\src-tauri\target\release\bundle\nsis\Vendavis_2.0.0_x64-setup.exe /S
# Uninstall: %LOCALAPPDATA%\Vendavis\uninstall.exe /S
```

### Toolchain on this machine

Node 24 / npm 11, Python 3.12 (`%LOCALAPPDATA%\Programs\Python\Python312`; `python` on PATH opens the Store alias — use the venv at `backend\.venv`), Rust stable (MSVC) + VS 2022 Build Tools, Salesforce CLI 2.157 (`%APPDATA%\npm\sf.CMD`).

### Testing the packaged backend without the UI

Launch the installed app, find the backend's port (it is dynamic in release builds: `netstat -ano | findstr LISTENING` for the `sf_backend` PIDs), then `Invoke-RestMethod http://127.0.0.1:<port>/api/sf-version`. In dev the port is fixed at 7891.

---

## Things that will bite you

- **Tauri needs `backend/dist/sf_backend.exe` to exist** even for `cargo check`. `npm run build:backend` creates it (gitignored); an empty placeholder file also works for compile-only checks.
- **Error text flows through Rust.** The WebView calls the backend via Tauri IPC (`api_get` / `api_post` in `src-tauri/src/main.rs`), so a backend error message is only visible in the UI if `http_error()` and `frontend/src/api/client.js` pass it through. Streaming calls (`apiStream`) use `fetch` directly instead.
- **Most backend routes wrap errors** as `except Exception as e: raise HTTPException(500, str(e))`. A global handler in `main.py` recovers `SessionExpiredError` from `__context__`; keep that in mind when adding new error types.
- **`@opencode/sdk` vs `@opencode/client` vs `@opencode-ai/sdk`** are three different packages; none is a drop-in chat client. See section 4 of the main handoff.
- **Tauri v2 capabilities:** list `core:event:allow-listen` and `core:event:allow-emit` explicitly; `core:event:default` doesn't exist.
- **LF/CRLF warnings** from git on Windows are harmless. When scripting edits in PowerShell, write files as UTF-8 without BOM and avoid line-ending rewrites (check `git diff --stat`).
- **The old `vendavis-handoff.docx` is deleted** (in git history). `HANDOFF.md` is from the Tkinter era and `HANDOFF-2026-11-05.md` covers feature work; both are background only.
- **Don't query or export real org data casually** — `vrm`, `gbr`, `san` are the developer's real orgs. Read-only limits/version calls are fine; ask before exports or anything that writes.
