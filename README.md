# SF Metadata Explorer v2 — Electron + React + FastAPI

Cross-platform desktop app (macOS · Windows · Linux).

## Architecture

```
sf-metadata-exp-electron/
├── backend/          # Python FastAPI server (localhost REST)
│   ├── main.py       # FastAPI app, all routes
│   ├── sf_cli.py     # Salesforce CLI wrappers
│   ├── excel_builder.py
│   ├── query_history.py
│   └── claude_client.py
├── electron/
│   ├── main.js       # Electron main process — spawns backend, creates window
│   └── preload.js    # Context bridge (IPC → renderer)
├── frontend/         # React + Vite + Tailwind
│   └── src/
│       ├── App.jsx
│       ├── api/client.js      # fetch wrapper with port injection
│       ├── components/        # OrgSelector, TabBar, Spinner
│       └── pages/             # FlsExplorer, SoqlRunner, ApexRunner, ClaudeChat
└── sf_fls_exporter.py  # Original Tkinter app (preserved)
```

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

# 3. Root (Electron + concurrently)
cd ..
npm install
```

## Run in dev mode

```bash
npm run dev
# Starts: Vite dev server (port 5173) + FastAPI backend (port auto) + Electron
```

## Build for distribution

```bash
# Build frontend
npm run build:frontend

# Bundle Python backend (run once per platform)
npm run build:backend

# Package Electron app
npm run dist
# → dist/SF Metadata Explorer-2.0.0.dmg (macOS)
# → dist/SF Metadata Explorer Setup 2.0.0.exe (Windows)
# → dist/SF Metadata Explorer-2.0.0.AppImage (Linux)
```

## Environment variables

| Variable            | Default | Purpose                        |
|---------------------|---------|--------------------------------|
| `SF_BACKEND_PORT`   | 7891    | Port for FastAPI server        |
| `ANTHROPIC_API_KEY` | —       | Claude API key (or `~/.anthropic_key`) |

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
