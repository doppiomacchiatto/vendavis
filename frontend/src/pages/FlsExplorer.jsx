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

  // Validation Rules state
  const [vrRules,       setVrRules]       = useState([]);
  const [vrLoading,     setVrLoading]     = useState(false);
  const [vrOpen,        setVrOpen]        = useState(false);
  const [vrExpanded,    setVrExpanded]    = useState(null);  // rule name with expanded formula
  const [vrConfirm,     setVrConfirm]     = useState(null);  // { rule, newActive }
  const [vrToggling,    setVrToggling]    = useState(null);  // rule name being toggled
  const [vrBulkBusy,   setVrBulkBusy]   = useState(false); // bulk op in progress
  const [vrSnapshot,   setVrSnapshot]    = useState(null);  // names active before bulk-disable
  const [fieldPage,   setFieldPage]   = useState(0);
  const FIELD_PAGE_SIZE = 20;
  const [fieldSort,   setFieldSort]   = useState({ col: "label", dir: "asc" });
  const [guideOpen,   setGuideOpen]   = useState(true);

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
    setVrRules([]);
    setVrSnapshot(null);
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
      const rules = d.rules || [];
      setVrRules(rules);
      log(`${rules.length} validation rule(s) loaded for ${obj.label}`, "success");
      await loadVrSnapshot(obj, rules);
    } catch (e) {
      log(`Validation rules error: ${e.message}`, "error");
    } finally {
      setVrLoading(false);
    }
  }

  // ── Bulk-disable restore snapshot (persisted by the backend as JSON) ─────────
  const vrSnapshotUrl = (obj) => `/api/orgs/${org.alias}/objects/${obj.apiName}/validation-rules/snapshot`;

  async function saveVrSnapshot(obj, names) {
    await api(vrSnapshotUrl(obj), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: names }),
    });
  }

  // Load the saved snapshot, keeping only rules that still exist and are still off.
  // If nothing is left to restore (e.g. re-enabled in Setup), clear the saved file.
  async function loadVrSnapshot(obj, rules) {
    try {
      const d = await api(vrSnapshotUrl(obj));
      const saved = d.snapshot?.rules || [];
      if (saved.length === 0) { setVrSnapshot(null); return; }
      const offNames = new Set(rules.filter(r => !r.active).map(r => r.name));
      const pending = saved.filter(n => offNames.has(n));
      if (pending.length !== saved.length) await saveVrSnapshot(obj, pending);
      setVrSnapshot(pending.length ? pending : null);
      if (pending.length) log(`Restore snapshot found: ${pending.length} rule(s) were disabled by Disable All (saved ${d.snapshot.savedAt})`);
    } catch (e) {
      log(`Could not read restore snapshot: ${e.message}`, "error");
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

  // ── Bulk VR toggle ───────────────────────────────────────────────────────────
  async function bulkToggleVR(targetActive) {
    const obj = selectedObj;
    const toToggle = targetActive
      ? vrRules.filter(r => !r.active && (!vrSnapshot || vrSnapshot.includes(r.name)))  // restore snapshot (or Enable All)
      : vrRules.filter(r => r.active);                                                    // disable all active

    if (toToggle.length === 0) return;

    // Persist the snapshot BEFORE disabling anything, so Restore survives switching
    // objects/tabs and app restarts. Merge with any rules still waiting to be restored.
    // If it can't be saved, don't disable anything.
    if (!targetActive) {
      const names = [...new Set([...(vrSnapshot || []), ...toToggle.map(r => r.name)])];
      try {
        await saveVrSnapshot(obj, names);
      } catch (e) {
        log(`Could not save the restore snapshot, nothing was disabled: ${e.message}`, "error");
        return;
      }
      setVrSnapshot(names);
    }

    setVrBulkBusy(true);
    const action = targetActive ? "Enabling" : "Disabling";
    log(`${action} ${toToggle.length} validation rule(s) on ${selectedObj.label}…`);

    let failed = 0;
    const failedNames = [];
    for (const rule of toToggle) {
      setVrToggling(rule.name);
      try {
        await api(`/api/orgs/${org.alias}/objects/${selectedObj.apiName}/validation-rules/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule_name: rule.name, active: targetActive }),
        });
        setVrRules(prev => prev.map(r => r.name === rule.name ? { ...r, active: targetActive } : r));
        log(`"${rule.name}" ${targetActive ? "enabled" : "disabled"}`, "success");
      } catch (e) {
        log(`"${rule.name}" failed: ${e.message}`, "error");
        failed++;
        failedNames.push(rule.name);
      }
    }

    setVrToggling(null);
    setVrBulkBusy(false);
    if (targetActive) {
      // Keep only the rules that failed to restore, so they can be retried
      try { await saveVrSnapshot(obj, failedNames); }
      catch (e) { log(`Could not update restore snapshot: ${e.message}`, "error"); }
      setVrSnapshot(failedNames.length ? failedNames : null);
    }
    const ok = toToggle.length - failed;
    log(`Bulk ${targetActive ? "enable" : "disable"} complete — ${ok}/${toToggle.length} succeeded`, failed ? "error" : "success");
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
    <div className="flex h-full relative">
      {overlayMsg && (
        <LoadingOverlay
          message={overlayMsg}
          onCancel={exporting ? handleCancel : undefined}
        />
      )}

      {/* ── Floating guidance panel ─────────────────────────────────────────── */}
      {guideOpen && (
        <div className="absolute top-3 right-3 z-20 w-56 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-700 rounded-xl shadow-lg overflow-hidden">
          <div className="flex items-center justify-between bg-blue-600 px-3 py-2">
            <span className="text-xs font-semibold text-white tracking-wide">How to use</span>
            <button onClick={() => setGuideOpen(false)} className="text-blue-200 hover:text-white text-sm leading-none">✕</button>
          </div>
          <div className="px-3 py-3 flex flex-col gap-2.5">
            {[
              ["1", "Select object(s)", "Check the box next to one or more objects in the sidebar (required before loading or exporting)"],
              ["2", "Load Fields",      "Click an object name to view its field-level security details in the main panel"],
              ["3", "Export to Excel",  "With objects checked, click Export to Excel — max 25 objects per export"],
            ].map(([n, title, desc]) => (
              <div key={n} className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-xs font-bold flex items-center justify-center mt-0.5">{n}</span>
                <div>
                  <p className="text-xs font-semibold text-gray-800 dark:text-gray-100">{title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
            <p className="text-xs text-amber-600 dark:text-amber-400 border-t border-gray-100 dark:border-gray-700 pt-2 mt-0.5">
              ⚠ Max 25 objects per export
            </p>
          </div>
        </div>
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
              <table className="w-full text-sm border-collapse table-fixed">
                <colgroup>
                  <col style={{ width: "28%" }} />
                  <col style={{ width: "28%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase tracking-wider select-none border-b border-gray-200 dark:border-gray-600">
                  <tr>
                    {[
                      { col: "label",    label: "Label",    cls: "text-left" },
                      { col: "apiName",  label: "API Name", cls: "text-left" },
                      { col: "type",     label: "Type",     cls: "text-left" },
                      { col: "required", label: "Req",      cls: "text-center", title: "Required on record create" },
                      { col: "readable", label: "Readable", cls: "text-center" },
                      { col: "editable", label: "Editable", cls: "text-center" },
                    ].map(({ col, label, cls, title }) => (
                      <th
                        key={col}
                        title={title}
                        onClick={() => toggleSort(col)}
                        className={`px-3 py-2 font-semibold text-gray-500 dark:text-gray-400 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors ${cls}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          {fieldSort.col === col
                            ? <span className="text-blue-500">{fieldSort.dir === "asc" ? "↑" : "↓"}</span>
                            : <span className="text-gray-300 dark:text-gray-600">↕</span>
                          }
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                  {sortedFields(fields)
                    .slice(fieldPage * FIELD_PAGE_SIZE, (fieldPage + 1) * FIELD_PAGE_SIZE)
                    .map((f, i) => (
                    <tr
                      key={f.apiName}
                      className={`group transition-colors ${
                        i % 2 === 0
                          ? "bg-white dark:bg-gray-800"
                          : "bg-gray-50/60 dark:bg-gray-800/40"
                      } hover:bg-blue-50/60 dark:hover:bg-blue-900/10`}
                    >
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100 truncate" title={f.label}>{f.label}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-400 dark:text-gray-500 truncate" title={f.apiName}>{f.apiName}</td>
                      <td className="px-3 py-2">
                        <span className="inline-block px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 capitalize">
                          {f.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {f.required
                          ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-xs font-bold" title="Required on create">✱</span>
                          : <span className="text-gray-200 dark:text-gray-700">—</span>
                        }
                      </td>
                      <td className="px-3 py-2 text-center">
                        {f.readable
                          ? <span className="text-green-500" title="Readable">✓</span>
                          : <span className="text-gray-300 dark:text-gray-600">✗</span>
                        }
                      </td>
                      <td className="px-3 py-2 text-center">
                        {f.editable
                          ? <span className="text-green-500" title="Editable">✓</span>
                          : <span className="text-gray-300 dark:text-gray-600">✗</span>
                        }
                      </td>
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
            <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-700/50 gap-2">
              {/* Expand/collapse toggle — left side */}
              <button
                onClick={() => {
                  if (!vrOpen && vrRules.length === 0 && !vrLoading) loadValidationRules(selectedObj);
                  setVrOpen((o) => !o);
                }}
                className="flex items-center gap-2 flex-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors select-none text-left"
              >
                <span className="text-gray-400">{vrOpen ? "▼" : "▶"}</span>
                <span>⚡ Validation Rules</span>
                {vrRules.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                    {vrRules.length}
                  </span>
                )}
                {vrLoading && <span className="text-gray-400 italic">loading…</span>}
              </button>

              {/* Bulk action buttons — right side, only when rules are loaded */}
              {vrRules.length > 0 && (
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Restore button — only shown after a bulk disable */}
                  {vrSnapshot && vrSnapshot.length > 0 && (
                    <button
                      disabled={vrBulkBusy}
                      onClick={() => bulkToggleVR(true)}
                      title={`Re-enable ${vrSnapshot.length} rule(s) that were active before Disable All`}
                      className="px-2.5 py-1 rounded text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50 disabled:opacity-40 transition-colors"
                    >
                      ↩ Restore ({vrSnapshot.length})
                    </button>
                  )}
                  {/* Disable All */}
                  {vrRules.some(r => r.active) && (
                    <button
                      disabled={vrBulkBusy}
                      onClick={() => bulkToggleVR(false)}
                      title="Disable all active validation rules on this object"
                      className="px-2.5 py-1 rounded text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 disabled:opacity-40 transition-colors"
                    >
                      {vrBulkBusy ? "…" : "Disable All"}
                    </button>
                  )}
                  {/* Enable All — only when all are currently off */}
                  {vrRules.every(r => !r.active) && !vrSnapshot && (
                    <button
                      disabled={vrBulkBusy}
                      onClick={() => bulkToggleVR(true)}
                      title="Enable all validation rules on this object"
                      className="px-2.5 py-1 rounded text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50 disabled:opacity-40 transition-colors"
                    >
                      {vrBulkBusy ? "…" : "Enable All"}
                    </button>
                  )}
                </div>
              )}
            </div>

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
