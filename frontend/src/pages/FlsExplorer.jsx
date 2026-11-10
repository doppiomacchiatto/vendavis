import { useState, useRef } from "react";
import { api } from "../api/client";
import Spinner from "../components/Spinner";
import LoadingOverlay from "../components/LoadingOverlay";
import DebugLogPanel from "../components/DebugLogPanel";

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

  // Validation Rules state
  const [vrRules,       setVrRules]       = useState([]);
  const [vrLoading,     setVrLoading]     = useState(false);
  const [vrOpen,        setVrOpen]        = useState(false);
  const [vrExpanded,    setVrExpanded]    = useState(null);  // rule name with expanded formula
  const [vrConfirm,     setVrConfirm]     = useState(null);  // { rule, newActive }
  const [vrToggling,    setVrToggling]    = useState(null);  // rule name being toggled
  const [fieldPage,   setFieldPage]   = useState(0);
  const FIELD_PAGE_SIZE = 20;
  const [fieldSort,   setFieldSort]   = useState({ col: "label", dir: "asc" });

  function toggleSort(col) {
    setFieldSort(s => ({ col, dir: s.col === col && s.dir === "asc" ? "desc" : "asc" }));
    setFieldPage(0);
  }

  function sortedFields(flds) {
    const { col, dir } = fieldSort;
    return [...flds].sort((a, b) => {
      let av = a[col] ?? "";
      let bv = b[col] ?? "";
      // boolean columns: sort true first when asc
      if (typeof av === "boolean") { av = av ? 0 : 1; bv = bv ? 0 : 1; }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ?  1 : -1;
      return 0;
    });
  }

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
    log(`Loading objects from ${org.alias}…`);
    const r = await loadObjectsShared?.();
    if (!r) return;
    if (r.status === "loaded")       log(`Loaded ${r.count} objects in ${r.secs}s`, "success");
    else if (r.status === "skipped") log(`Objects already loaded (${r.count} cached)`);
    else if (r.status === "error")   log(`Failed to load objects: ${r.error}`, "error");
  }

  // ── Load Fields ─────────────────────────────────────────────────────────────
  async function loadFields(obj) {
    if (!org || !obj) return;
    setLoadingFld(true);
    setFields([]);
    setVrRules([]);
    setVrOpen(false);
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

  // ── Validation Rules ─────────────────────────────────────────────────────────
  async function loadValidationRules(obj) {
    if (!org || !obj) return;
    setVrLoading(true);
    setVrRules([]);
    log(`Loading validation rules for ${obj.label}…`);
    try {
      const d = await api(`/api/orgs/${org.alias}/objects/${obj.apiName}/validation-rules`);
      setVrRules(d.rules || []);
      log(`${(d.rules || []).length} validation rule(s) loaded for ${obj.label}`, "success");
    } catch (e) {
      log(`Validation rules error: ${e.message}`, "error");
    } finally {
      setVrLoading(false);
    }
  }

  async function confirmToggleVR() {
    if (!vrConfirm) return;
    const { rule, newActive } = vrConfirm;
    setVrConfirm(null);
    setVrToggling(rule.name);
    const action = newActive ? "Enabling" : "Disabling";
    log(`${action} "${rule.name}"…`);
    try {
      await api(`/api/orgs/${org.alias}/objects/${selectedObj.apiName}/validation-rules/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule_name: rule.name, active: newActive }),
      });
      setVrRules((prev) => prev.map((r) => r.name === rule.name ? { ...r, active: newActive } : r));
      log(`"${rule.name}" ${newActive ? "enabled" : "disabled"}`, "success");
    } catch (e) {
      log(`Toggle failed: ${e.message}`, "error");
    } finally {
      setVrToggling(null);
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
                <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider select-none">
                  <tr>
                    {[
                      { col: "label",    label: "Label",    cls: "" },
                      { col: "apiName",  label: "API Name", cls: "" },
                      { col: "type",     label: "Type",     cls: "" },
                      { col: "required", label: "Req",      cls: "text-center", title: "Required on record create" },
                      { col: "readable", label: "Readable", cls: "text-center" },
                      { col: "editable", label: "Editable", cls: "text-center" },
                    ].map(({ col, label, cls, title }) => (
                      <th
                        key={col}
                        title={title}
                        onClick={() => toggleSort(col)}
                        className={`px-3 py-2 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors ${cls}`}
                      >
                        {label}
                        {fieldSort.col === col && (
                          <span className="ml-1 text-blue-500">{fieldSort.dir === "asc" ? "↑" : "↓"}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedFields(fields)
                    .slice(fieldPage * FIELD_PAGE_SIZE, (fieldPage + 1) * FIELD_PAGE_SIZE)
                    .map((f, i) => (
                    <tr key={f.apiName} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-750"}>
                      <td className="px-3 py-1.5 truncate max-w-xs">{f.label}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-500 truncate">{f.apiName}</td>
                      <td className="px-3 py-1.5 text-gray-500 text-xs">{f.type}</td>
                      <td className="px-3 py-1.5 text-center">
                        {f.required && (
                          <span className="inline-block px-1.5 py-0.5 rounded text-xs font-bold bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400" title="Required on create">
                            *
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center text-green-600">{f.readable ? "✓" : ""}</td>
                      <td className="px-3 py-1.5 text-center text-green-600">{f.editable ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Validation Rules panel — collapsible ─────────────────────────── */}
        {fields.length > 0 && (
          <div className="shrink-0 border-t border-gray-200 dark:border-gray-700">
            {/* Header bar — always visible */}
            <button
              onClick={() => {
                if (!vrOpen && vrRules.length === 0 && !vrLoading) loadValidationRules(selectedObj);
                setVrOpen((o) => !o);
              }}
              className="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors select-none"
            >
              <span className="flex items-center gap-2">
                <span>⚡ Validation Rules</span>
                {vrRules.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                    {vrRules.length}
                  </span>
                )}
                {vrLoading && <span className="text-gray-400 italic">loading…</span>}
              </span>
              <span className="text-gray-400">{vrOpen ? "▲" : "▼"}</span>
            </button>

            {/* Expanded body */}
            {vrOpen && (
              <div className="overflow-auto max-h-64 bg-white dark:bg-gray-900">
                {vrRules.length === 0 && !vrLoading && (
                  <p className="px-4 py-3 text-xs text-gray-400 italic">No validation rules found.</p>
                )}
                {vrRules.length > 0 && (
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left uppercase text-gray-500 tracking-wider">
                      <tr>
                        <th className="px-3 py-2 w-14 text-center">Active</th>
                        <th className="px-3 py-2">Rule Name</th>
                        <th className="px-3 py-2">Error Field</th>
                        <th className="px-3 py-2">Error Message</th>
                        <th className="px-3 py-2">Formula</th>
                        <th className="px-3 py-2 w-20 text-center">Toggle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vrRules.map((r, i) => (
                        <tr key={r.name} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-800/60"}>
                          {/* Active indicator */}
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-block w-2.5 h-2.5 rounded-full ${r.active ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={r.active ? "Active" : "Inactive"} />
                          </td>
                          {/* Rule name + description tooltip */}
                          <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100 max-w-[160px]">
                            <span title={r.description || r.name} className="truncate block">{r.name}</span>
                          </td>
                          {/* Error field */}
                          <td className="px-3 py-2 font-mono text-gray-500 dark:text-gray-400 max-w-[120px]">
                            <span className="truncate block">{r.errorField || <span className="italic text-gray-300 dark:text-gray-600">Page</span>}</span>
                          </td>
                          {/* Error message */}
                          <td className="px-3 py-2 text-gray-600 dark:text-gray-300 max-w-[200px]">
                            <span className="truncate block" title={r.errorMessage}>{r.errorMessage}</span>
                          </td>
                          {/* Formula — click to expand */}
                          <td className="px-3 py-2 max-w-[200px]">
                            {r.errorConditionFormula ? (
                              <button
                                onClick={() => setVrExpanded((prev) => prev === r.name ? null : r.name)}
                                className="text-left font-mono text-blue-600 dark:text-blue-400 hover:underline w-full"
                              >
                                {vrExpanded === r.name
                                  ? <span className="whitespace-pre-wrap break-all block">{r.errorConditionFormula}</span>
                                  : <span className="truncate block">{r.errorConditionFormula}</span>
                                }
                              </button>
                            ) : <span className="text-gray-300 dark:text-gray-600 italic">—</span>}
                          </td>
                          {/* Toggle button */}
                          <td className="px-3 py-2 text-center">
                            {vrToggling === r.name
                              ? <span className="text-gray-400 italic">…</span>
                              : (
                                <button
                                  onClick={() => setVrConfirm({ rule: r, newActive: !r.active })}
                                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                                    r.active
                                      ? "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50"
                                      : "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
                                  }`}
                                >
                                  {r.active ? "Disable" : "Enable"}
                                </button>
                              )
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── VR Toggle confirm dialog ──────────────────────────────────────── */}
        {vrConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 flex flex-col gap-5">
              <div>
                <p className="font-semibold text-gray-900 dark:text-white text-base">
                  {vrConfirm.newActive ? "Enable" : "Disable"} Validation Rule?
                </p>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  <span className="font-mono font-medium">{vrConfirm.rule.name}</span>
                  {" "}on <span className="font-medium">{selectedObj?.label}</span> in{" "}
                  <span className="font-medium">{org?.alias}</span>
                </p>
                {!vrConfirm.newActive && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                    Disabling a validation rule affects all users in the org immediately.
                  </p>
                )}
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setVrConfirm(null)}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmToggleVR}
                  className={`px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors ${
                    vrConfirm.newActive ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
                  }`}
                >
                  {vrConfirm.newActive ? "Enable" : "Disable"}
                </button>
              </div>
            </div>
          </div>
        )}

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
