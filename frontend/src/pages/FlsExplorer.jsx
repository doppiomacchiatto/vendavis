import { useState, useRef } from "react";
import { api } from "../api/client";
import Spinner from "../components/Spinner";
import DebugLogPanel from "../components/DebugLogPanel";
import LoadingOverlay from "../components/LoadingOverlay";

export default function FlsExplorer({ org, ctx, setCtx, loadObjects: loadObjectsShared, onApiCall }) {
  // Objects come from shared ctx — no local copy needed
  const objects    = ctx?.objects || [];
  const objLoaded  = ctx?.objectsLoaded || false;
  const loadingObj = ctx?.objectsLoading || false;

  const [filter,      setFilter]      = useState("");
  const [selectedObj, setSelectedObj] = useState(null);
  const [exportSel,   setExportSel]   = useState([]);
  const [fields,      setFields]      = useState([]);
  const [loadingFld,  setLoadingFld]  = useState(false);
  const [exporting,   setExporting]   = useState(false);
  const [exportedFiles, setExportedFiles] = useState([]);
  const cancelRef = useRef(false);
  const [debugOpen,   setDebugOpen]   = useState(false);
  const [debugLog,    setDebugLog]    = useState([]);
  const [fieldPage,   setFieldPage]   = useState(0);
  const FIELD_PAGE_SIZE = 20;

  function log(msg, type = "info") {
    const ts = new Date().toISOString().slice(11, 23);
    const icon = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
    setDebugLog((l) => [...l, { ts, icon, msg }]);
    // Auto-open on errors
    if (type === "error") setDebugOpen(true);
  }

  // ── Load Objects — delegates to shared App.jsx loader ──────────────────────
  async function loadObjects() {
    if (!org) { log("No org selected", "error"); return; }
    log(`load_objects called for ${org.alias}…`);
    const r = await loadObjectsShared?.();
    if (!r) return;
    if (r.status === "loaded")       log(`load_objects finished: ${r.count} objects in ${r.secs}s`, "success");
    else if (r.status === "skipped") log(`load_objects skipped (${r.reason}, ${r.count} objects)`);
    else if (r.status === "error")   log(`load_objects failed after ${r.secs}s: ${r.error}`, "error");
  }

  // ── Load Fields ─────────────────────────────────────────────────────────────
  async function loadFields(obj) {
    if (!org || !obj) return;
    setLoadingFld(true);
    setFields([]);
    log(`Loading fields for ${obj.label} (${obj.apiName})…`);
    try {
      const d = await api(`/api/orgs/${org.alias}/objects/${obj.apiName}/fields`);
      const flds = d.fields || [];
      setFields(flds);
      setFieldPage(0);
      setCtx((c) => ({ ...c, fields: { ...c.fields, [obj.apiName]: flds } }));
      log(`${flds.length} fields loaded for ${obj.label}`, "success");
    } catch (e) {
      log(e.message, "error");
    } finally {
      setLoadingFld(false);
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!org || exportSel.length === 0) return;
    cancelRef.current = false;
    setExportedFiles([]);
    // Pick directory BEFORE showing overlay (native dialog blocks render)
    let dir = null;
    try {
      const { openDirDialog } = await import("../api/client");
      dir = await openDirDialog();
    } catch (e) {
      log(`Directory picker failed: ${e.message}`, "error");
      return;
    }
    const outputDir = (!dir || dir === "__default__") ? null : dir;
    setExporting(true);
    log(`Exporting ${exportSel.length} object(s): ${exportSel.join(", ")}…`);
    log(`Output directory: ${outputDir || "~/Downloads (default)"}`);
    dir = outputDir;
    try {
      const d = await api("/api/export", {
        method: "POST",
        body: JSON.stringify({ alias: org.alias, objects: exportSel, output_dir: dir }),
      });
      if (cancelRef.current) { log("Export cancelled"); return; }
      setExportedFiles(d.files || []);
      log(`Exported ${d.files.length} file(s)`, "success");
      d.files.forEach((f) => log(`  📄 ${f}`));
    } catch (e) {
      if (!cancelRef.current) log(e.message, "error");
    } finally {
      setExporting(false);
      cancelRef.current = false;
    }
  }

  function handleCancel() {
    cancelRef.current = true;
    setExporting(false);
    log("Export cancelled by user");
  }

  async function openFile(filePath) {
    log(`Opening: ${filePath}`);
    try {
      if (window.__TAURI__) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_file", { path: filePath });
      } else {
        // In dev (browser), ask the Python backend to open via OS subprocess
        await api("/api/open_file", {
          method: "POST",
          body: JSON.stringify({ path: filePath }),
        });
      }
      log("File opened", "success");
    } catch (e) {
      log(`Could not open file: ${e}`, "error");
    }
  }

  function toggleExport(apiName) {
    setExportSel((prev) =>
      prev.includes(apiName) ? prev.filter((a) => a !== apiName) : [...prev, apiName]
    );
  }

  const filtered = objects.filter(
    (o) =>
      o.label.toLowerCase().includes(filter.toLowerCase()) ||
      o.apiName.toLowerCase().includes(filter.toLowerCase())
  );

  const overlayMsg = loadingObj
    ? `Loading objects from ${org?.alias}…`
    : loadingFld
    ? `Loading fields for ${selectedObj?.label}…`
    : exporting
    ? `Exporting ${exportSel.length} object(s) to Excel…`
    : null;

  return (
    <div className="flex h-full">
      {overlayMsg && (
        <LoadingOverlay
          message={overlayMsg}
          onCancel={exporting ? handleCancel : undefined}
        />
      )}

      {/* ── Object sidebar ──────────────────────────────────────────────────── */}
      <aside className="w-72 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          <button
            onClick={loadObjects}
            disabled={loadingObj || !org}
            className="w-full py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {loadingObj ? <Spinner label="Loading objects…" /> : "⬇ Load Objects"}
          </button>
          {objLoaded && (
            <input
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Filter objects…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>

        <div className="flex-1 overflow-y-auto text-sm">
          {!objLoaded && !loadingObj && (
            <div className="p-6 text-center text-gray-400 text-xs">
              Click <strong>Load Objects</strong> to fetch sObjects from the org.
            </div>
          )}
          {filtered.map((o) => (
            <div
              key={o.apiName}
              onClick={() => { setSelectedObj(o); setFields([]); }}
              className={`px-3 py-2 cursor-pointer border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 ${
                selectedObj?.apiName === o.apiName
                  ? "bg-blue-50 dark:bg-blue-900/30"
                  : "hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              <input
                type="checkbox"
                checked={exportSel.includes(o.apiName)}
                onChange={(e) => { e.stopPropagation(); toggleExport(o.apiName); }}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 accent-blue-600"
              />
              <div className="min-w-0">
                <div className="font-medium truncate">{o.label}</div>
                <div className="text-xs text-gray-400 truncate">{o.apiName}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom actions */}
        <div className="p-2 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          {selectedObj && (
            <button
              onClick={() => loadFields(selectedObj)}
              disabled={loadingFld}
              className="w-full py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {loadingFld ? <Spinner label="Loading fields…" /> : `⬇ Load Fields — ${selectedObj.label}`}
            </button>
          )}
          <button
            disabled={exportSel.length === 0 || exporting}
            onClick={handleExport}
            className="w-full py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {exporting ? <Spinner label="Exporting…" /> : `📥 Export ${exportSel.length} object(s) to Excel`}
          </button>

          {/* Open exported workbook */}
          {exportedFiles.length > 0 && (() => {
            const filePath = exportedFiles[0];
            const sep = filePath.includes("/") ? "/" : "\\";
            const parts = filePath.split(sep);
            parts.pop();
            const dir = parts.join(sep);
            const friendlyDir = dir.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, "~");
            return (
              <button
                onClick={() => openFile(filePath)}
                className="w-full py-1.5 px-2 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 rounded-lg transition-colors text-left"
                title={filePath}
              >
                <div className="truncate font-semibold">📂 Open Workbook</div>
                <div className="truncate text-emerald-500 dark:text-emerald-500 font-normal">{friendlyDir}</div>
              </button>
            );
          })()}
        </div>
      </aside>

      {/* ── Right panel: fields (75%) + debug log (25%) ─────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Fields table — takes all space when debug closed, 75% when open */}
        <div className={`flex flex-col ${debugOpen ? "h-3/4" : "flex-1"} overflow-hidden`}>
          {/* Header bar */}
          <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 text-sm text-gray-500 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between shrink-0">
            <span>
              {loadingFld
                ? <Spinner label="Loading fields…" />
                : fields.length
                  ? `${fields.length} fields — ${selectedObj?.label} (${selectedObj?.apiName})`
                  : selectedObj
                    ? `Click "Load Fields" to inspect ${selectedObj.label}`
                    : "Select an object from the sidebar"
              }
            </span>
            {/* Pagination controls */}
            {fields.length > FIELD_PAGE_SIZE && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">
                  {fieldPage * FIELD_PAGE_SIZE + 1}–{Math.min((fieldPage + 1) * FIELD_PAGE_SIZE, fields.length)} of {fields.length}
                </span>
                <button
                  disabled={fieldPage === 0}
                  onClick={() => setFieldPage((p) => p - 1)}
                  className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
                >◀</button>
                <button
                  disabled={(fieldPage + 1) * FIELD_PAGE_SIZE >= fields.length}
                  onClick={() => setFieldPage((p) => p + 1)}
                  className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
                >▶</button>
              </div>
            )}
          </div>

          {/* Scrollable table */}
          <div className="flex-1 overflow-auto">
            {fields.length > 0 && (
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider">
                  <tr>
                    <th className="px-3 py-2">Label</th>
                    <th className="px-3 py-2">API Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2 text-center">Readable</th>
                    <th className="px-3 py-2 text-center">Editable</th>
                  </tr>
                </thead>
                <tbody>
                  {fields
                    .slice(fieldPage * FIELD_PAGE_SIZE, (fieldPage + 1) * FIELD_PAGE_SIZE)
                    .map((f, i) => (
                    <tr key={f.apiName} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50"}>
                      <td className="px-3 py-1.5 truncate max-w-xs">{f.label}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-500 truncate">{f.apiName}</td>
                      <td className="px-3 py-1.5 text-gray-500 text-xs">{f.type}</td>
                      <td className="px-3 py-1.5 text-center text-green-600">{f.readable ? "✓" : ""}</td>
                      <td className="px-3 py-1.5 text-center text-green-600">{f.editable ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Debug log — collapsible ───────────────────────────────────────── */}
        <DebugLogPanel
          entries={debugLog}
          open={debugOpen}
          onToggle={() => setDebugOpen((o) => !o)}
          onClear={() => setDebugLog([])}
          heightClass="h-1/4"
        />
      </div>
    </div>
  );
}
