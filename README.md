# SF Metadata Explorer v2 — Electron + React + FastAPI

Cross-platform desktop app (macOS · Windows · Linux).

## Architecture

```
sf-metadata-exp-electron/
├── backend/              # Python FastAPI server (localhost REST)
│   ├── main.py           # FastAPI app, all routes
│   ├── sf_cli.py         # Salesforce CLI wrappers (delegates to platform_env)
│   ├── platform_env.py   # OS-specific PATH & tool-discovery abstraction
│   ├── excel_builder.py
│   ├── query_history.py
│   └── ai_client.py      # Provider-agnostic AI client (OpenAI-compatible API)
├── src-tauri/
│   ├── src/main.rs       # Tauri shell — spawns backend binary, creates window
│   └── tauri.conf.json
├── frontend/             # React + Vite + Tailwind
│   └── src/
│       ├── App.jsx
│       ├── api/client.js        # fetch wrapper with port injection
│       ├── components/          # OrgPickerModal, TabBar, Spinner, …
│       └── pages/               # FlsExplorer, SoqlRunner, ApexRunner, OrgHealth, ClaudeChat
└── sf_fls_exporter.py    # Original Tkinter app (preserved for reference)
```

---

## Platform Environment (`backend/platform_env.py`)

### The problem

When Vendavis runs as a packaged `.app` / `.exe` / AppImage, the OS launches it with a minimal `PATH` — only the handful of directories the system considers safe defaults. This omits Homebrew (`/opt/homebrew/bin`), nvm, Volta, npm-global, and all other user-installed tool locations. The Salesforce CLI (`sf`) is a Node.js script, so even if the binary is found, calling it fails immediately if `node` is not on the `PATH`.

A naive fix — hardcoding macOS paths in `sf_cli.py` — would break on Windows and Linux and would require touching multiple files every time a new OS is supported.

### Design: abstract provider pattern

`platform_env.py` introduces a small hierarchy modelled on the Strategy / Template Method pattern:

```
PlatformProvider  (abstract base class)
├── MacOSProvider   — Homebrew, nvm, Volta, n, npm-global, Yarn
├── WindowsProvider — %APPDATA%\npm, nvm-windows, Volta, Chocolatey, Scoop
└── LinuxProvider   — npm-global, nvm, Volta, n, Snap
```

`PlatformProvider` defines the interface every OS must implement:

| Method | Purpose |
|---|---|
| `extra_paths() → List[str]` | **Abstract.** Returns ordered directories to prepend to `PATH`. Each OS knows its own install conventions. |
| `sf_cli_candidates() → List[str]` | **Override.** Absolute paths to check for `sf`/`sfdx` as a last resort when `shutil.which` finds nothing. |
| `augmented_path() → str` | **Concrete.** Merges `extra_paths()` with the current process `PATH`, deduplicating entries. Used as `env["PATH"]` for every subprocess call. |
| `find_tool(*names) → Optional[str]` | **Concrete.** Calls `shutil.which` over the augmented path, then falls back to iterating `sf_cli_candidates()`. |

A module-level factory, `get_platform()`, returns the singleton provider for the running OS using `sys.platform`:

```python
from platform_env import get_platform

plat = get_platform()           # MacOSProvider / WindowsProvider / LinuxProvider
sf   = plat.find_tool("sf", "sfdx")
env  = {"PATH": plat.augmented_path(), **os.environ}
```

`sf_cli.py` imports `get_platform()` and delegates entirely — no platform `if` branches in the CLI wrapper itself.

### Adding a new OS or a new OS-specific function

To support a new platform (e.g. FreeBSD), subclass `PlatformProvider`, implement `extra_paths()`, add it to the `get_platform()` factory, and nothing else changes.

To add a new OS-specific capability — for example `default_config_dir()` (macOS → `~/Library/Application Support`, Windows → `%APPDATA%`, Linux → `~/.config`) — add an abstract method to `PlatformProvider` and implement it in each subclass. All call sites use `get_platform().default_config_dir()` without any platform checks.

### Windows paths (`WindowsProvider`)

The Windows subclass is already implemented and ready for the Windows build phase. It covers:

- `%APPDATA%\npm` — npm global installs (the Windows default)
- `%LOCALAPPDATA%\nvm` — nvm-windows
- `%LOCALAPPDATA%\Volta\bin` — Volta
- `C:\ProgramData\chocolatey\bin` — Chocolatey
- `%USERPROFILE%\scoop\shims` — Scoop
- `C:\Program Files\nodejs` — Node.js installer default

The `sf_cli_candidates()` list also includes `.cmd` wrapper variants, which Windows npm installs generate alongside the bare binary name.

---

## Dev setup (first time)

```bash
# 1. Python backend
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2. Frontend deps
cd ../frontend
npm install

# 3. Root (Tauri + concurrently)
cd ..
npm install
```

## Run in dev mode

```bash
npm run dev
# Starts: Vite dev server (port 5173) + FastAPI backend (port 7891) + Tauri window
```

## Build for distribution

```bash
# Build frontend
npm run build:frontend

# Bundle Python backend with PyInstaller (run once per platform)
npm run build:backend

# Package via Tauri
npx tauri build
# → src-tauri/target/release/bundle/dmg/Vendavis_*.dmg  (macOS)
# → src-tauri/target/release/bundle/msi/Vendavis_*.msi  (Windows)
# → src-tauri/target/release/bundle/appimage/Vendavis_*.AppImage (Linux)
```

## Environment variables

| Variable             | Default | Purpose                                                        |
|----------------------|---------|----------------------------------------------------------------|
| `SF_BACKEND_PORT`    | 7891    | Port for FastAPI server                                        |
| `VENDAVIS_DEBUG`     | off     | `1` logs every `sf` CLI call and its duration to the backend console |
| `OPENCODE_API_KEY`   | —       | AI provider API key (`ANTHROPIC_API_KEY` is also read). Overrides the key saved in Settings |
| `OPENCODE_BASE_URL`  | —       | AI gateway URL. Overrides the URL saved in Settings            |
| `OPENCODE_MODEL`     | —       | AI model id. Overrides the model saved in Settings             |

---

## AI assistant configuration (OpenCode and other providers)

The OpenCode tab and the AI panels in SOQL Runner and Apex Runner talk to any **OpenAI-compatible** provider. You are not tied to one vendor: pick a provider, paste a key and choose a model, all from **⚙ Settings** in the top bar. AI features are optional; the rest of the app works without a key.

### Configure in Settings

1. Click **⚙ Settings**.
2. Choose a **Provider**. This fills in the **Gateway URL** and shows the right key format.
3. Paste your **API Key**. Leave it blank to keep the key already saved.
4. Pick a **Model**. The list is fetched live from the provider; click **↻ Refresh list** after changing the key or gateway. If the provider can't be reached, a built-in list is shown with the reason.
5. Click **Save**.

### Providers

| Provider | Gateway URL | API key | Notes |
|---|---|---|---|
| OpenCode | `https://opencode.ai/inference/openai/v1` | `oc_sk_…` | Create a personal key at opencode.ai/console → Account → Personal API keys. Pay-as-you-go: the workspace needs credits and the model must be enabled in the workspace. Free-tier models only work inside OpenCode itself |
| OpenAI (ChatGPT models) | `https://api.openai.com/v1` | `sk-…` | |
| Anthropic (Claude) | `https://api.anthropic.com/v1` | `sk-ant-…` | Create a key at console.anthropic.com → Settings → API keys |
| Google (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai` | `AIza…` | |
| OpenRouter | `https://openrouter.ai/api/v1` | `sk-or-…` | Llama and many other models |
| Groq | `https://api.groq.com/openai/v1` | `gsk_…` | Hosted Llama |
| Ollama (local) | `http://localhost:11434/v1` | not needed | Lists the models you have pulled. Any `localhost` gateway works without a key |
| Custom | your URL | your key | Any OpenAI-compatible gateway (LiteLLM, vLLM, LM Studio, …) |

**Auto** (blank gateway): an `oc_sk_` key uses the OpenCode gateway; any other key goes to OpenAI.

> The key used by the OpenCode terminal app or desktop app is stored separately and is not shared with Vendavis. Vendavis keeps its own key, so create or paste one in Settings.

### Where settings are stored

| Setting | Location |
|---|---|
| API key | `~/.vendavis_api_key` (plain text, written by Settings) |
| Model and gateway URL | `~/.vendavis_config.json` |

Treat `~/.vendavis_api_key` like any credential file. To remove the key, delete the file.

### Config priority

For each of key, gateway URL and model, the first source that has a value wins:

1. `opencode.config.json` (project root, developer override; see the file for reference provider blocks)
2. `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `OPENCODE_MODEL` environment variables
3. Values saved in Settings (`~/.vendavis_api_key`, `~/.vendavis_config.json`)
4. The legacy SOQL Explorer config (`~/.sf_tools_config.json`)

If Settings changes seem to be ignored in dev, check that `opencode.config.json` and the env vars above don't set the same value.

### Troubleshooting

| Error | Cause and fix |
|---|---|
| `401 Incorrect API key provided … platform.openai.com` | The gateway URL is blank, so the key was sent to OpenAI. Choose the matching **Provider** in Settings |
| `401 Invalid credential` | The key isn't valid for that provider (for example an OpenAI key sent to OpenCode). Paste the right key |
| `401 invalid x-api-key` | Anthropic rejected the key. Create a new key in the Anthropic console |
| `403 Model access is disabled` | The model id isn't enabled for your account or workspace. Pick a model from the refreshed list |
| `Insufficient account funds` | The provider account has no credit. Add credit with that provider |
| "Couldn't fetch models" under the Model picker | Check the key and gateway URL, then **↻ Refresh list**. The built-in list is shown meanwhile |

---

## Debugging

- **🐞 Debug** (top bar) opens a log of every backend API call with its duration, plus `load_objects` start, finish and a progress heartbeat. It has Filter, Copy and Clear.
- Each tab (FLS Explorer, Profiles & PermSets, SOQL Runner, Apex Runner) also has a collapsible **Debug Log** panel at the bottom with the same Filter, Copy and Clear controls.
- Set `VENDAVIS_DEBUG=1` before launching the backend to log each Salesforce CLI command and how long it took.

---

## Future State

### Bulk Profile / Permission Set Export (Async Queue)

The current export flow works well for a single profile or permission set scoped to a selected object list (< 200 objects). For very large orgs — or use cases where a user wants to export all objects for a profile without pre-selecting — a synchronous HTTP request will time out and the SF CLI bulk SOQL approach hits practical limits.

The correct architecture for that use case is an asynchronous job queue backed by Apex:

**Salesforce side — Queueable Apex job submission.** Vendavis submits an Apex job via the Tooling API or Anonymous Apex that enqueues a `QueueableContext` job. The job runs server-side inside the org, iterates all FieldPermissions and ObjectPermissions for the requested principal, and writes results to a Custom Object (e.g. `VendavisExportJob__c` with fields for status, result payload URL or chunked JSON blobs, error message, and completed timestamp).

**Callback / polling mechanism.** Because Salesforce cannot push to a local desktop app, Vendavis polls the `VendavisExportJob__c` record on a configurable interval (e.g. every 5 seconds) until status transitions to `Completed` or `Failed`. Alternatively, a Platform Event (`VendavisJobComplete__e`) could be subscribed to via CometD/Streaming API for near-real-time notification, but polling is simpler and sufficient for most orgs.

**Job Queue UI component.** A dedicated Job Queue panel in Vendavis would show all submitted jobs with columns for principal name, object scope, status (Queued / Running / Done / Failed), elapsed time, and an "Open Workbook" action once done. The panel would persist across tab switches and survive app restarts by storing job IDs in local storage. Users could cancel in-flight jobs by calling `System.abortJob()` via anonymous Apex.

**Why this is deferred.** This approach requires deploying Apex classes and a Custom Object to the target org, which is a non-trivial installation step and may be blocked by org security policies. The current synchronous approach — scoped to a user-selected object list — covers the primary use case (auditing a specific application's objects) without any org-side installation. If full-org export becomes a hard requirement, the async queue approach is the right path.

### Apex Code Save to File

The Apex Runner currently holds code only in memory for the session. A natural next step is a **Save** button (💾) in the Execute toolbar that writes the editor contents to a `.cls` file on the user's local drive — defaulting to `~/Downloads/anonymous_apex_<timestamp>.cls` or opening the OS save dialog for a custom path and filename. The saved file could then be opened in an external editor (VS Code, IntelliJ) via the standard OS "open with" mechanism. A complementary **Open** button would let the user load an existing `.cls` file back into the editor. The backend already has `open_file` (OS shell open) and the `openSaveDialog` helper in `client.js` provides the Tauri save dialog; only the read/write endpoints and the toolbar buttons need to be added.

A secondary variant is **AI conversation export** — saving the Claude AI chat transcript (user prompts + assistant responses, including code blocks) as a `.md` or `.txt` file. This is useful for sharing a generated Apex solution with a teammate or keeping a record of the AI-assisted development session.

### Multi-Profile Batch Export

Currently the Profiles & PermSets tab exports one profile at a time. A natural next step is to allow the user to select multiple profiles in the left sidebar (checkboxes, same pattern as objects), then kick off a sequential batch export — one workbook per profile — with the overlay showing "Exporting profile 2 of 3…". Each workbook lands in the output directory named after the profile. The in-process FLS cache makes this fast: Query 1 only runs once per profile, so a 3-profile batch with 5 objects each would complete in roughly the same time as 3 individual exports back to back. The "Exported Workbooks" history panel in the sidebar already supports listing multiple workbooks, so the UI is ready — only the export trigger and the loop need to be added.

### Inline Record Editing in SOQL Runner

The SOQL results grid currently displays query output as a read-only table. A natural evolution is to make individual cells **editable in-place** with a "Commit Changes" button that activates only when at least one cell has been dirtied.

**UX flow.**
- Clicking a cell puts it into edit mode (a borderless `<input>` or `<textarea>` in-place, matching the cell width).
- Edited cells are highlighted (e.g. light yellow/amber background) so the user can see exactly what has changed before committing.
- A **Commit Changes** button lives in the results toolbar. It renders greyed-out (`disabled`, `opacity-50`) until at least one cell is dirty; once a change is made it activates with a blue/green highlight.
- An optional **Discard** button resets all dirty cells back to their original values without making any API calls.

**Under the hood.**
- The component maintains a `dirtyMap` — a `Map<rowIndex_fieldName, newValue>` — updated on every `onChange`. `isDirty = dirtyMap.size > 0` drives the Commit button's disabled state.
- On Commit, the frontend groups dirty cells by record `Id`, then calls a new backend endpoint `PATCH /api/orgs/{alias}/records` with a payload like `[{ sobject, id, fields: { Field__c: "new value" } }]`.
- The backend translates each entry into an `sf data update record` CLI call (or a Composite REST API bulk patch for efficiency on large change sets). Each operation returns success/failure per record; partial failures are surfaced inline on the affected rows without blocking successful ones.
- After a successful commit the `dirtyMap` is cleared, the result rows are updated with the new values, and a green toast confirms how many records were updated.

**Salesforce constraints to surface in the UI.**
- Not all fields are editable (formula fields, system fields like `CreatedDate`, fields the running user lacks FLS write access to). The app should detect non-updateable fields from the `describe` response and render those cells as permanently read-only even in edit mode.
- The `Id` field is never editable and should be visually distinguished (e.g. monospace, locked icon).
- Bulk updates via the Composite API count against Daily API Requests — the footer limit counter should reflect the calls made on Commit.
