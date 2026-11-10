# Vendavis — Session Handoff (current)

**Date:** 2026-11-09 (evening)
**Machine:** Windows 11, project at `C:\Users\juan\dev\app\vendavis`
**Branch:** `opencode/mvp-0` — fully **pushed** to `origin/opencode/mvp-0` (remote `git@github.com:doppiomacchiatto/vendavis.git`). Working tree clean (`git log --oneline -8` for the current HEAD).
**Branch policy (from the developer):** this feature branch stays **separate from `main`. No PR.** Push to `opencode/mvp-0` only.

This is the "pick up here" note. The full reference (architecture, Windows design, build details) stays in [`HANDOFF-2026-11-09.md`](HANDOFF-2026-11-09.md) — read it before changing anything non-trivial.

---

## Paste this to start the session

> I'm continuing work on Vendavis, a Tauri v2 + React + FastAPI desktop Salesforce metadata explorer, at `C:\Users\juan\dev\app\vendavis` (branch `opencode/mvp-0`). Read `HANDOFF-2026-11-09-opencode-session.md` and then `HANDOFF-2026-11-09.md` in that folder. I'm on Windows/PowerShell. Push only to `opencode/mvp-0` — no PR, nothing to `main`. Keep the AI layer vendor-neutral. Start with the "Next steps" list.

An assistant needs file + command access to do real work (shell + filesystem, or an agent running in the project folder).

---

## State of the project

Windows support, the release build, error handling, the debug tooling and provider-neutral AI are done. The installed app has **not** been fully clicked through against a real org by the developer yet (see "Not yet clicked through").

| Area | Status |
|---|---|
| `npm run tauri:build` | Works; produces MSI + NSIS installers in `src-tauri/target/release/bundle/` |
| NSIS install | Installed at `%LOCALAPPDATA%\Vendavis`, latest build (everything through `fc23584`) |
| Windows process cleanup | Job Object; `cargo test` passes; killing the app kills the backend |
| `sf_backend.spec` | Tracked; one-file build works |
| Expired-session errors | Clear 401 message `... run sf org login web --alias X` |
| `/api/debug-env` | Removed |
| React `ErrorBoundary` | Added (`frontend/src/components/ErrorBoundary.jsx`); never rendered with a forced crash |
| Load Objects | ~23 s on `vrm` (was 4m15s) |
| AI | Provider-neutral OpenAI-compatible client (`backend/ai_client.py`, `/api/ai/chat`); works with an Anthropic key. `@opencode/sdk` was evaluated and **rejected** — it is an in-process server host, not a chat client. Do not re-add it |

### Salesforce orgs on this machine

| Alias | Session |
|---|---|
| `vrm` (default) | Valid (5,446 objects via REST describe-global) |
| `gbr` | Expired — needs `sf org login web --alias gbr` |
| `san` | Expired — needs `sf org login web --alias san` |

---

## What this session did

| Commit | Change |
|---|---|
| `32e9321` | **Load Objects 4m15s → ~23s.** `list_objects` makes one REST describe-global call (old EntityDefinition paging kept as fallback). Added `VENDAVIS_DEBUG=1` backend logging. Fixed React error #310 in `OrgHealthCheck` (hooks moved above an early return in `ClaudeChat.jsx`) |
| `783c795` | **🐞 Debug modal** in the top bar: every `api()` call with duration, plus `load_objects` called / finished / 10 s heartbeat / skipped / failed (`frontend/src/debugLog.js`, `components/DebugLogModal.jsx`) |
| `c3b0237` | Shared **`DebugLogPanel`** (Filter / Copy / Clear) replaces the four copy-pasted per-tab Debug Log panels (FLS, Profiles, SOQL, Apex). `loadObjects` in `App.jsx` now **returns** `{status, count, secs}` so tabs can log the result |
| `b56f275` | UI text "Claude AI" → **"OpenCode AI"** (SOQL/Apex panels, Help, Settings). An `oc_sk_` key with no gateway URL defaults to the OpenCode gateway |
| `d2b3d66` | SOQL Runner Load Objects shows the Braille-spinner `LoadingOverlay` and logs the result |
| `fc23584` | **Settings: Provider presets + live model list** (below) |
| `bef4fbe`, `10ef46b`, `84fc903` | README: AI provider configuration, config priority, troubleshooting, debugging; Electron references removed (Tauri now); out-of-date handoffs removed |

---

## Design decisions worth keeping

- **Vendor-neutral AI.** The backend speaks the OpenAI-compatible API only (`openai` SDK). Developers choose the provider in ⚙ Settings; nobody is boxed into one vendor.
- **Provider presets** (`PROVIDER_PRESETS` in `ai_client.py`, returned by `GET /api/settings`): OpenCode, OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Ollama (local, no key), Custom. Azure OpenAI is deliberately not a preset (per-deployment URLs + `api-version`); usable via Custom for chat, the model list may not populate. **Cursor is not supported** — no public chat API for third-party apps.
- **Live model picker.** `POST /api/models` calls the provider's `/models` (accepts unsaved key/URL from the form so "↻ Refresh list" works before saving). Falls back to the static `AVAILABLE_MODELS` with the error shown. Handled in `_client_kwargs` / `fetch_models`: Anthropic needs an `anthropic-version` header; Gemini ids carry a `models/` prefix; embeddings/whisper/tts/dall-e/moderation are filtered out; `localhost` gateways get a dummy key.

### Current AI config on this machine (secrets not recorded here)

`~/.vendavis_config.json`: gateway `https://api.anthropic.com/v1`, model `claude-sonnet-4-6`. `~/.vendavis_api_key`: an Anthropic key the developer created in console.anthropic.com. The developer confirmed AI works with this setup.

---

## Verified vs. not verified

**Verified by the developer:** Load Objects ~23.6 s in the installed app; AI panel works with the Anthropic key and gateway.

**Verified by tests during the session (not clicked in the UI):** `/api/models` live against Anthropic (15 models), bad-key fallback, OpenAI-style list filtering, Gemini prefix stripping, Ollama no-key path (mocked for everything except Anthropic). Frontend compiles.

**Not yet clicked through in the installed app:**
- Settings: Provider dropdown, ↻ Refresh list, model note
- SOQL Runner loading overlay
- Filter / Copy / Clear on the four per-tab Debug Log panels, and the 🐞 modal
- OpenCode gateway with a funded `oc_sk_` key
- Every other tab against `vrm`: FLS Explorer, Profiles & PermSets, SOQL, Apex, **Health** (the API Limits checks were the original bug report) and the footer API-limits gauge

---

## Next steps (priority order)

1. **Click through the installed app against `vrm`** — the "not yet clicked through" list above. Fix anything that fails.
2. **Load Objects, round two** (23 s → ~7 s): ~16 of the 23 s are two `sf` CLI calls (`org display` + `org auth show-access-token`, ~8 s each) inside `_rest_get` in `backend/sf_cli.py`. Cache the instance URL + token per org (refresh on 401, as the code already does) and/or run the two calls in parallel.
3. **Force a crash to see the ErrorBoundary** (e.g. temporarily `throw` in a page component). It compiles and is wired in `main.jsx` but has never rendered.
4. **Verify the token-refresh path.** `get_org_limits` forces a refresh and retries once on a 401. Only exercised against fully-expired orgs (error path). Test with an org whose access token is stale but whose refresh token is valid.
5. **Run `npm run dev`** once (Vite + uvicorn + Tauri dev mode) — only the release build has been exercised.
6. **Install the MSI** (per-machine, needs admin) — only NSIS was tried.
7. **Code signing** for the Windows installers (SmartScreen warns on unsigned).
8. **Optional:** UI progress count for long loads (SSE, as the export endpoint does).
9. **TODO — remove Claude-specific naming and code** (user-facing text is already "OpenCode"; what's left is internal). Inventory:
   - **Frontend:** rename `frontend/src/pages/ClaudeChat.jsx` and its `ClaudeChat` component (e.g. `OpenCodeChat`); update the import and `<ClaudeChat>` usage in `App.jsx`; the tab id `"claude"` in `App.jsx` (`TABS` and the `activeTab` check); the "shared between OrgHealth tab and ClaudeChat" comment in `data/healthChecks.js`.
   - **Switch the call sites to the active endpoint:** `SoqlRunner.jsx` (line ~66) and `ApexRunner.jsx` (line ~87) still POST to `/api/claude/chat`. Point them at `/api/ai/chat`, then remove the compat alias `/api/claude/chat` (`claude_chat_compat`) in `backend/main.py`. Don't remove the alias first.
   - **Decision (developer): the legacy Tkinter app is not part of this branch.** So remove it along with the Claude client it depends on:
     - Delete `sf_fls_exporter.py` (repo root, ~100 `claude` identifiers) and `backend/claude_client.py` (imported only by it; unused by the app).
     - README: drop the `sf_fls_exporter.py    # Original Tkinter app (preserved for reference)` line from the architecture tree.
     - Reword the module docstrings that say "for sf_fls_exporter" in `backend/sf_cli.py`, `backend/excel_builder.py` and `backend/query_history.py`.
     - `backend/sf_backend.spec`: drop the moot comment ("Legacy Anthropic client is kept in the repo…"); the `excludes` list can stay.
     - `~/.sf_tools_config.json` (legacy SOQL Explorer config) is still read as the last-priority fallback in `ai_client.py` and shown in Settings ("using key from SOQL Explorer config"). Separate decision — keep or drop that fallback with the cleanup.
   - **Keep, these are not cleanup:** the Anthropic provider preset and its `anthropic-version` header handling in `ai_client.py`; the `anthropic_compat` block in `opencode.config.json`; Claude model ids and labels in `AVAILABLE_MODELS`; `ANTHROPIC_API_KEY` as an env-var fallback for the key.
10. **Other polish:** collapse the OrgPicker debug log behind "Show details"; the `console.log` in `api/client.js` is still ungated (the in-memory debug log is always on, capped at 500 entries); `npm audit` reports 2 vulnerabilities (1 moderate, 1 high) in `frontend/`.

---

## How to work on this machine

PowerShell, not bash. Rust was installed earlier, so a **new terminal** is needed for `cargo` to be on PATH; otherwise run `$env:Path += ";$env:USERPROFILE\.cargo\bin"`.

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

# Backend with SF CLI timing logs, then hit the live-model endpoint
$env:VENDAVIS_DEBUG = "1"; npm run dev:backend
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7891/api/models -ContentType application/json -Body '{}'
```

### Toolchain on this machine

Node 24 / npm 11, Python 3.12 (`%LOCALAPPDATA%\Programs\Python\Python312`; `python` on PATH opens the Store alias — use the venv at `backend\.venv`), Rust stable (MSVC) + VS 2022 Build Tools, Salesforce CLI 2.157 (`%APPDATA%\npm\sf.CMD`).

### Testing the packaged backend without the UI

Launch the installed app, find the backend's port (dynamic in release builds: `netstat -ano | findstr LISTENING` for the `sf_backend` PIDs), then `Invoke-RestMethod http://127.0.0.1:<port>/api/sf-version`. In dev the port is fixed at 7891.

---

## Things that will bite you

- **`opencode.config.json` beats Settings.** Priority per value: `opencode.config.json` → `OPENCODE_*` env vars → Settings files → legacy config. The repo's file sets `"model": "gpt-4o"`, so in dev it can override the model chosen in Settings. Documented in the README.
- **Two different "OpenCode" credentials.** The terminal OpenCode app keeps its own credential (here: a direct Anthropic API key in its SQLite DB at `~/.local/share/opencode/opencode.db`, table `credential`). Vendavis cannot read it; it has its own key file. The OpenCode **Console gateway** (`oc_sk_` keys) is a separate pay-as-you-go product: needs credits, only workspace-enabled models work (`claude-sonnet-4-6` was *not* enabled; `claude-sonnet-5-5` was), and free-tier models only work inside OpenCode itself.
- **Describe-global vs EntityDefinition.** The REST fast path returns 5,446 objects for `vrm` vs 5,315 from the old EntityDefinition query (different notion of "retrievable"). Labels are `.strip()`ped because some arrive with surrounding spaces.
- **Tauri needs `backend/dist/sf_backend.exe` to exist** even for `cargo check`. `npm run build:backend` creates it (gitignored); an empty placeholder file also works for compile-only checks.
- **Error text flows through Rust.** The WebView calls the backend via Tauri IPC (`api_get` / `api_post` in `src-tauri/src/main.rs`), so a backend error message is only visible in the UI if `http_error()` and `frontend/src/api/client.js` pass it through. Streaming calls (`apiStream`) use `fetch` directly.
- **Most backend routes wrap errors** as `except Exception as e: raise HTTPException(500, str(e))`. A global handler in `main.py` recovers `SessionExpiredError` from `__context__`; keep that in mind when adding new error types.
- **`@opencode/sdk` vs `@opencode/client` vs `@opencode-ai/sdk`** are three different packages; none is a drop-in chat client. See section 4 of `HANDOFF-2026-11-09.md`.
- **Tauri v2 capabilities:** list `core:event:allow-listen` and `core:event:allow-emit` explicitly; `core:event:default` doesn't exist.
- **Installing the app:** an NSIS `/S` install misbehaves if Vendavis is running. Stop `sf-metadata-explorer` and `sf_backend` first.
- **Red `NativeCommandError` after `git push` in PowerShell is harmless** — git writes progress to stderr. Check the `old..new` line and `git status -sb`.
- **LF/CRLF warnings** from git on Windows are harmless. When scripting edits in PowerShell, write UTF-8 without BOM and avoid line-ending rewrites (check `git diff --stat`).
- **Old handoffs are deleted** (in git history): `vendavis-handoff.docx`, `HANDOFF.md`, `HANDOFF-2026-11-05.md`, `HANDOFF-2026-11-09-claude-desktop.md`.
- **`vrm`, `gbr`, `san` are the developer's real orgs.** Read-only calls (version, limits, object list) are fine; ask before exports or anything that writes.
- **`~/.vendavis_api_key` is a plain-text secret.** Never paste or log its contents; show prefix/length only.
