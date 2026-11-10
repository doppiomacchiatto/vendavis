# Vendavis — Session Handoff (OpenCode session: perf, debug tooling, AI providers)

**Date:** 2026-11-09 (evening)
**Machine:** Windows 11, project at `C:\Users\juan\dev\app\vendavis`
**Branch:** `opencode/mvp-0` — everything below is **pushed** to `origin/opencode/mvp-0` (remote `git@github.com:doppiomacchiatto/vendavis.git`). Working tree clean. Code HEAD at time of writing: `bef4fbe` (this handoff is the commit on top).
**Branch policy (from the developer):** this feature branch stays **separate from `main`. No PR.** Push to `opencode/mvp-0` only.

Read order for a new session: this file → [`HANDOFF-2026-11-09-claude-desktop.md`](HANDOFF-2026-11-09-claude-desktop.md) (project state, toolchain) → [`HANDOFF-2026-11-09.md`](HANDOFF-2026-11-09.md) (architecture, Windows design, build). The "6 commits unpushed" statements in those two are now out of date.

---

## What this session did

| Commit | Change |
|---|---|
| `32e9321` | **Load Objects 4m15s → ~23s.** `list_objects` now makes one REST describe-global call (with the old EntityDefinition paging as fallback). Added `VENDAVIS_DEBUG=1` backend logging. Fixed React error #310 in `OrgHealthCheck` (hooks moved above an early return in `ClaudeChat.jsx`) |
| `783c795` | **🐞 Debug modal** in the top bar: logs every `api()` call with duration, plus `load_objects` called / finished / 10 s heartbeat / skipped / failed (`frontend/src/debugLog.js`, `components/DebugLogModal.jsx`) |
| `c3b0237` | Shared **`DebugLogPanel`** (Filter / Copy / Clear) replaces the four copy-pasted per-tab Debug Log panels (FLS, Profiles, SOQL, Apex). `loadObjects` in `App.jsx` now **returns** `{status, count, secs}` so tabs can log the result |
| `b56f275` | UI text "Claude AI" → **"OpenCode AI"** (SOQL/Apex panels, Help, Settings). `ai_client.py`: an `oc_sk_` key with no gateway URL defaults to the OpenCode gateway |
| `d2b3d66` | SOQL Runner Load Objects now shows the Braille-spinner `LoadingOverlay` (as FLS/Profiles do) and logs the result |
| `fc23584` | **Settings: Provider presets + live model list** (see below) |
| `bef4fbe` | README: AI provider configuration, config priority, troubleshooting, debugging |

The latest NSIS build (includes everything through `fc23584`) is installed at `%LOCALAPPDATA%\Vendavis`.

---

## Design decisions worth keeping

- **Vendor-neutral AI.** The backend speaks the OpenAI-compatible API only (`openai` SDK, `backend/ai_client.py`). Developers choose the provider in ⚙ Settings; nobody is boxed into one vendor.
- **Provider presets** (`PROVIDER_PRESETS` in `ai_client.py`, returned by `GET /api/settings`): OpenCode, OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Ollama (local, no key), Custom. Azure OpenAI is deliberately not a preset (needs per-deployment URLs + `api-version`; usable via Custom for chat, model list may not populate). **Cursor is not supported**: it has no public chat API for third-party apps.
- **Live model picker.** `POST /api/models` calls the provider's `/models` (accepts unsaved key/URL from the form so "↻ Refresh list" works before saving). Falls back to the static `AVAILABLE_MODELS` with the error shown. Quirks handled in `_client_kwargs` / `fetch_models`: Anthropic needs an `anthropic-version` header; Gemini ids carry a `models/` prefix; embeddings/whisper/tts/dall-e/moderation are filtered out; `localhost` gateways get a dummy key.
- **No `@opencode/sdk`** — still rejected (see the other handoffs). AI chat stays on the Python proxy.

### Current AI config on this machine (secrets not recorded here)

`~/.vendavis_config.json`: gateway `https://api.anthropic.com/v1`, model `claude-sonnet-4-6`. `~/.vendavis_api_key`: an Anthropic key the developer created in console.anthropic.com. The developer confirmed AI works with this setup.

---

## Verified vs. not verified

**Verified by the developer:** Load Objects in the installed app takes ~23.6 s; AI panel works with the Anthropic key and gateway.

**Verified by tests during the session (not clicked in the UI):** `/api/models` live against Anthropic (15 models), bad-key fallback, OpenAI-style list filtering, Gemini prefix stripping, Ollama no-key path (mocked responses for everything except Anthropic). Frontend compiles.

**Not yet clicked through in the installed app:**
- The Provider dropdown / ↻ Refresh list / model note in Settings
- SOQL Runner loading overlay
- Filter / Copy / Clear on the four per-tab Debug Log panels, and the 🐞 modal
- OpenCode gateway with a funded `oc_sk_` key (see gotchas)

---

## Next steps

1. **Click through the items above** in the installed app against `vrm`.
2. **Load Objects, round two** (23 s → ~7 s): ~16 of the 23 s are two `sf` CLI calls (`org display` + `org auth show-access-token`, ~8 s each) inside `_rest_get` in `backend/sf_cli.py`. Cache the instance URL + token per org (refresh on 401, as the code already does) and/or run the two calls in parallel.
3. **Optional UI progress** for long loads (SSE count, as the export endpoint does).
4. **Remaining polish from the earlier handoff:** collapse the OrgPicker debug log behind "Show details"; the `console.log` in `api/client.js` is still ungated (the in-memory debug log is always on and capped at 500 entries); delete `backend/claude_client.py` (still tracked, unused); `npm audit` shows 2 vulnerabilities in `frontend/`.
5. **Rename leftovers:** the `ClaudeChat.jsx` file/component name and a few comments still say "Claude"; user-facing text is already "OpenCode".
6. Items still open from the Claude Desktop handoff: ErrorBoundary forced-crash test, token-refresh path with a stale-but-valid refresh token, `npm run dev`, MSI install, code signing.

---

## Things that will bite you

- **`opencode.config.json` beats Settings.** Priority per value: `opencode.config.json` → `OPENCODE_*` env vars → Settings files → legacy config. The repo's file sets `"model": "gpt-4o"`, so in dev it can override the model chosen in Settings. Documented in the README.
- **Two different "OpenCode" credentials.** The terminal OpenCode app keeps its own credential (here: a direct Anthropic API key, stored in its SQLite DB at `~/.local/share/opencode/opencode.db`, table `credential`). Vendavis cannot read it; it has its own key file. The OpenCode **Console gateway** (`oc_sk_` keys) is a separate pay-as-you-go product: needs credits, only workspace-enabled models work (e.g. `claude-sonnet-4-6` was *not* enabled; `claude-sonnet-5-5` was), and free-tier models only work inside OpenCode itself.
- **Describe-global vs EntityDefinition.** The REST fast path returns 5,446 objects for `vrm` vs 5,315 from the old EntityDefinition query (different notion of "retrievable"). Labels are `.strip()`ped because some arrive with surrounding spaces.
- **Installing the app:** NSIS `/S` install fails or misbehaves if Vendavis is running. Stop `sf-metadata-explorer` and `sf_backend` first.
- **Red `NativeCommandError` after `git push` in PowerShell is harmless** — git writes progress to stderr. Check the `old..new` line and `git status -sb`.
- **`python` on PATH is the Microsoft Store alias** — use `backend\.venv\Scripts\python.exe`.
- **`vrm` is a real org.** Read-only calls (version, limits, object list) are fine; ask before exports or anything that writes.
- **`~/.vendavis_api_key` is a plain-text secret.** Never paste or log its contents; show prefix/length only.

---

## Quick commands (PowerShell)

```powershell
# Frontend compile check / full release build / install over the existing app
cd frontend; npm run build
npm run tauri:build
Get-Process sf-metadata-explorer, sf_backend -ErrorAction SilentlyContinue | Stop-Process -Force
.\src-tauri\target\release\bundle\nsis\Vendavis_2.0.0_x64-setup.exe /S

# Backend with SF CLI timing logs, then hit the live-model endpoint
$env:VENDAVIS_DEBUG = "1"; npm run dev:backend
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7891/api/models -ContentType application/json -Body '{}'
```
