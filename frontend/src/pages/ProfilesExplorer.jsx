import { useState, useRef } from "react";
import { api } from "../api/client";
import Spinner from "../components/Spinner";
import LoadingOverlay from "../components/LoadingOverlay";

const FIELD_PAGE_SIZE = 30;

export default function ProfilesExplorer({ org }) {
  // ── Principal state ────────────────────────────────────────────────────────
  const [profiles,       setProfiles]       = useState([]);
  const [permsets,       setPermsets]       = useState([]);
  const [principalTab,   setPrincipalTab]   = useState("profiles"); // "profiles"|"permsets"
  const [selected,       setSelected]       = useState(null);       // {type, name}
  const [filter,         setFilter]         = useState("");
  const [loadingP,       setLoadingP]       = useState(false);
  const [loadingPS,      setLoadingPS]      = useState(false);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [permsetsLoaded, setPermsetsLoaded] = useState(false);

  // ── Object + FLS state ─────────────────────────────────────────────────────
  const [objects,      setObjects]      = useState([]);
  const [objFilter,    setObjFilter]    = useState("");
  const [selectedObj,  setSelectedObj]  = useState(null);
  const [checkedObjs,  setCheckedObjs]  = useState(new Set()); // multi-select for export
  const [objsLoaded,   setObjsLoaded]   = useState(false);
  const [loadingObjs,  setLoadingObjs]  = useState(false);
  const [flsData,      setFlsData]      = useState(null);  // {obj_perms, fls: {field: {readable, editable}}}
  const [loadingFls,   setLoadingFls]   = useState(false);
  const [fieldPage,    setFieldPage]    = useState(0);
  const [fieldFilter,  setFieldFilter]  = useState("");

  // ── Export ────────────────────────────────────────────────────────────────
  const [exporting,       setExporting]       = useState(false);
  const [exportHistory,   setExportHistory]   = useState([]); // [{principal, file}]
  const [exportedFiles,   setExportedFiles]   = useState([]);
  const [exportStatus,    setExportStatus]    = useState("");
  const [helpOpen,        setHelpOpen]        = useState(false);
  const cancelRef = useRef(false);

  // ── Debug log ─────────────────────────────────────────────────────────────
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog,  setDebugLog]  = useState([]);

  function log(msg, type = "info") {
    const ts   = new Date().toISOString().slice(11, 23);
    const icon = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
    setDebugLog((l) => [...l, { ts, icon, msg }]);
    if (type === "error") setDebugOpen(true);
  }

  // ── Loaders ────────────────────────────────────────────────────────────────
  async function loadProfiles() {
    if (!org) { log("No org selected", "error"); return; }
    setLoadingP(true);
    log(`Loading profiles from ${org.alias}…`);
    try {
      const d = await api(`/api/orgs/${org.alias}/profiles`);
      setProfiles(d.profiles || []);
      setProfilesLoaded(true);
      log(`${(d.profiles || []).length} profiles loaded`, "success");
    } catch (e) { log(e.message, "error"); }
    finally     { setLoadingP(false); }
  }

  async function loadPermsets() {
    if (!org) { log("No org selected", "error"); return; }
    setLoadingPS(true);
    log(`Loading permission sets from ${org.alias}…`);
    try {
      const d = await api(`/api/orgs/${org.alias}/permsets`);
      setPermsets(d.permsets || []);
      setPermsetsLoaded(true);
      log(`${(d.permsets || []).length} permission sets loaded`, "success");
    } catch (e) { log(e.message, "error"); }
    finally     { setLoadingPS(false); }
  }

  async function loadObjects() {
    if (!org) return;
    setLoadingObjs(true);
    setObjects([]); setSelectedObj(null); setFlsData(null); setCheckedObjs(new Set());
    log(`Loading objects…`);
    try {
      const d = await api(`/api/orgs/${org.alias}/objects`);
      setObjects(d.objects || []);
      setObjsLoaded(true);
      log(`${(d.objects || []).length} objects loaded`, "success");
    } catch (e) { log(e.message, "error"); }
    finally     { setLoadingObjs(false); }
  }

  function toggleCheck(apiName) {
    setCheckedObjs((prev) => {
      const next = new Set(prev);
      if (next.has(apiName)) next.delete(apiName);
      else next.add(apiName);
      return next;
    });
  }

  function clearSelected() {
    setCheckedObjs(new Set());
  }

  function toggleAllVisible() {
    const allChecked = filteredObjs.every((o) => checkedObjs.has(o.apiName));
    setCheckedObjs((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        filteredObjs.forEach((o) => next.delete(o.apiName));
      } else {
        filteredObjs.forEach((o) => next.add(o.apiName));
      }
      return next;
    });
  }

  async function loadFls(obj) {
    if (!org || !selected || !obj) return;
    setLoadingFls(true);
    setFlsData(null);
    setFieldPage(0);
    setFieldFilter("");
    log(`Loading FLS for ${selected.name} × ${obj.label}…`);
    try {
      const endpoint = selected.type === "profile"
        ? `/api/orgs/${org.alias}/profiles/${encodeURIComponent(selected.name)}/objects/${obj.apiName}/fls`
        : `/api/orgs/${org.alias}/permsets/${encodeURIComponent(selected.name)}/objects/${obj.apiName}/fls`;
      const d = await api(endpoint);
      setFlsData(d);
      log(`FLS loaded — ${Object.keys(d.fls || {}).length} field permission entries`, "success");
    } catch (e) { log(e.message, "error"); }
    finally     { setLoadingFls(false); }
  }

  async function handleExport() {
    if (!org || !selected || checkedObjs.size === 0) return;
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
    setExportStatus("Starting export…");
    const objList = [...checkedObjs];
    log(`Exporting FLS for ${selected.name} — ${objList.length} object(s)…`);
    dir = outputDir;
    try {
      const port = window.__SF_BACKEND_PORT__ || 7891;
      const res = await fetch(`http://localhost:${port}/api/export/principal`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          alias:          org.alias,
          principal_type: selected.type,
          principal_name: selected.name,
          objects:        objList,
          output_dir:     dir,
        }),
      });

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buf = "";
      while (true) {
        if (cancelRef.current) break;
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.error) { log(obj.error, "error"); return; }
            if (obj.status) { setExportStatus(obj.status); log(obj.status); }
            if (obj.files)  {
              setExportedFiles(obj.files);
              const filePath = obj.files[0];
              // Build a human-friendly folder label (~/Downloads, ~/Desktop, etc.)
              const sep = filePath.includes("/") ? "/" : "\\";
              const parts = filePath.split(sep);
              parts.pop(); // remove filename
              const dir = parts.join(sep);
              // Replace /Users/<name> or /home/<name> or C:\Users\<name> with ~
              const friendlyDir = dir.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, "~");
              setExportHistory((h) => [
                { principal: selected.name, file: filePath, dir: friendlyDir },
                ...h.filter((e) => e.principal !== selected.name),
              ]);
              log(`Exported ${obj.files.length} file(s)`, "success");
            }
          } catch {}
        }
      }
    } catch (e) {
      if (!cancelRef.current) log(e.message, "error");
    } finally {
      setExporting(false);
      setExportStatus("");
      cancelRef.current = false;
    }
  }

  function handleCancel() {
    cancelRef.current = true;
    setExporting(false);
    log("Export cancelled by user");
  }

  async function openFile(filePath) {
    if (window.__TAURI__) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file", { path: filePath }).catch(() => {});
    }
  }

  function selectPrincipal(type, name) {
    setSelected({ type, name });
    setFlsData(null);
    setSelectedObj(null);
    setExportedFiles([]);
    setCheckedObjs(new Set());
    log(`Selected ${type === "profile" ? "Profile" : "PermSet"}: ${name}`);
  }

  // ── Derived lists ──────────────────────────────────────────────────────────
  const currentList = principalTab === "profiles" ? profiles : permsets;
  const filteredPrincipals = currentList.filter((n) =>
    n.toLowerCase().includes(filter.toLowerCase())
  );
  const filteredObjs = objects.filter(
    (o) =>
      o.label.toLowerCase().includes(objFilter.toLowerCase()) ||
      o.apiName.toLowerCase().includes(objFilter.toLowerCase())
  );

  // FLS table rows
  const allFields = flsData
    ? Object.entries(flsData.fls || {}).map(([fname, perms]) => ({ fname, ...perms }))
    : [];
  const filteredFields = allFields.filter(
    (f) =>
      f.fname.toLowerCase().includes(fieldFilter.toLowerCase())
  );
  const pagedFields = filteredFields.slice(
    fieldPage * FIELD_PAGE_SIZE,
    (fieldPage + 1) * FIELD_PAGE_SIZE
  );

  const overlayMsg = loadingObjs
    ? "Loading objects…"
    : loadingFls
    ? `Loading FLS for ${selectedObj?.label}…`
    : exporting
    ? (exportStatus || `Exporting ${selected?.name}…`)
    : null;

  const OBJ_PERMS = [
    ["Read",        "AllowRead"],
    ["Create",      "AllowCreate"],
    ["Edit",        "AllowEdit"],
    ["Delete",      "AllowDelete"],
    ["View All",    "ViewAllRecords"],
    ["Modify All",  "ModifyAllRecords"],
  ];

  return (
    <div className="flex h-full">
      {overlayMsg && (
        <LoadingOverlay
          message={overlayMsg}
          subtitle={exporting ? "Estimated time: 1–3 min depending on org size. Please stand by." : undefined}
          onCancel={exporting ? handleCancel : undefined}
        />
      )}

      {/* ── Help modal ───────────────────────────────────────────────────── */}
      {helpOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setHelpOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-800 dark:text-white">How to Export FLS</h2>
              <button onClick={() => setHelpOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">✕</button>
            </div>
            <ol className="flex flex-col gap-3 text-sm text-gray-600 dark:text-gray-300">
              <li className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">1</span>
                <span>Select a <strong>Profile</strong> or <strong>Permission Set</strong> from the left sidebar. Click <em>Load Profiles</em> or <em>Load Perm Sets</em> first if the list is empty.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">2</span>
                <span>Click <strong>Load Objects</strong> in the middle column. Use the filter box to find specific objects, then check the ones you want to export (2–20 is ideal).</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">3</span>
                <span>Click an object row to preview its field-level security in the right panel. This does not affect the export selection.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">4</span>
                <span>Click <strong>📥 Export N Objects</strong>. Choose an output folder (or press Enter for Downloads). One Excel workbook is created with a Manifest tab + one tab per object.</span>
              </li>
              <li className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">5</span>
                <span>Switch to another profile and repeat. Each export appears in the <strong>Exported Workbooks</strong> list below — click any entry to open it.</span>
              </li>
            </ol>
            <p className="text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 pt-3">
              💡 The first export for each profile takes ~15s. Re-exporting the same profile with different objects is near-instant thanks to in-memory caching.
            </p>
          </div>
        </div>
      )}

      {/* ── Left sidebar: principals ──────────────────────────────────────── */}
      <aside className="w-72 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shrink-0">
        {/* Tab toggle + help */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          {[["profiles", "👤 Profiles"], ["permsets", "🔑 Perm Sets"]].map(([id, label]) => (
            <button
              key={id}
              onClick={() => { setPrincipalTab(id); setSelected(null); setFilter(""); }}
              className={`flex-1 py-2 text-xs font-semibold transition-colors ${
                principalTab === id
                  ? "bg-blue-600 text-white"
                  : "text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setHelpOpen(true)}
            className="px-3 py-2 text-xs font-bold text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors border-l border-gray-200 dark:border-gray-700"
            title="How to use this tab"
          >
            ?
          </button>
        </div>

        {/* Load button */}
        <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          {principalTab === "profiles" ? (
            <button
              onClick={loadProfiles}
              disabled={loadingP || !org}
              className="w-full py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {loadingP ? <Spinner label="Loading…" /> : "⬇ Load Profiles"}
            </button>
          ) : (
            <button
              onClick={loadPermsets}
              disabled={loadingPS || !org}
              className="w-full py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {loadingPS ? <Spinner label="Loading…" /> : "⬇ Load Perm Sets"}
            </button>
          )}

          {((principalTab === "profiles" && profilesLoaded) ||
            (principalTab === "permsets" && permsetsLoaded)) && (
            <input
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>

        {/* Principal list */}
        <div className="flex-1 overflow-y-auto text-sm">
          {filteredPrincipals.length === 0 && !loadingP && !loadingPS && (
            <div className="p-6 text-center text-gray-400 text-xs">
              Click <strong>Load</strong> to fetch{" "}
              {principalTab === "profiles" ? "profiles" : "permission sets"}.
            </div>
          )}
          {filteredPrincipals.map((name) => (
            <div
              key={name}
              onClick={() => selectPrincipal(principalTab === "profiles" ? "profile" : "permset", name)}
              className={`px-3 py-2 cursor-pointer border-b border-gray-100 dark:border-gray-700 truncate ${
                selected?.name === name && selected?.type === (principalTab === "profiles" ? "profile" : "permset")
                  ? "bg-blue-50 dark:bg-blue-900/30 font-semibold text-blue-700 dark:text-blue-300"
                  : "hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
              title={name}
            >
              {name}
            </div>
          ))}
        </div>

        {/* Export button + history */}
        {selected && (
          <div className="p-2 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
            {checkedObjs.size === 0 && objsLoaded && (
              <div className="text-xs text-center text-amber-600 dark:text-amber-400">
                ☑ Check objects to export
              </div>
            )}
            <button
              onClick={handleExport}
              disabled={exporting || checkedObjs.size === 0}
              className="w-full py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {exporting
                ? <Spinner label="Exporting…" />
                : checkedObjs.size > 0
                  ? `📥 Export ${checkedObjs.size} Object${checkedObjs.size !== 1 ? "s" : ""}`
                  : `📥 Export`}
            </button>
          </div>
        )}

        {/* Export history — persists across profile switches */}
        {exportHistory.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-700 flex flex-col">
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Exported Workbooks
            </div>
            <div className="overflow-y-auto max-h-48 flex flex-col gap-1 px-2 pb-2">
              {exportHistory.map((entry) => (
                <button
                  key={entry.principal}
                  onClick={() => openFile(entry.file)}
                  className="w-full py-1.5 px-2 text-xs font-medium bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 rounded-lg transition-colors text-left"
                  title={entry.file}
                >
                  <div className="truncate font-semibold">📂 {entry.principal}</div>
                  <div className="truncate text-emerald-500 dark:text-emerald-500 font-normal">{entry.dir}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ── Middle: object picker ─────────────────────────────────────────── */}
      <aside className="w-64 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 shrink-0">
        <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          <button
            onClick={loadObjects}
            disabled={loadingObjs || !org || !selected}
            className="w-full py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {loadingObjs ? <Spinner label="Loading…" /> : "⬇ Load Objects"}
          </button>
          {objsLoaded && (
            <input
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Filter objects…"
              value={objFilter}
              onChange={(e) => setObjFilter(e.target.value)}
            />
          )}
          {objsLoaded && (
            <div className="flex items-center justify-between gap-1">
              <button
                onClick={toggleAllVisible}
                className="flex-1 py-1 text-xs font-medium bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
              >
                {filteredObjs.length > 0 && filteredObjs.every((o) => checkedObjs.has(o.apiName))
                  ? "☑ Deselect All"
                  : "☐ Select All"}
              </button>
              {checkedObjs.size > 0 && (
                <button
                  onClick={clearSelected}
                  className="py-1 px-2 text-xs font-medium bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-700 rounded transition-colors whitespace-nowrap"
                >
                  ✕ Clear
                </button>
              )}
            </div>
          )}
          {checkedObjs.size > 0 && (
            <div className="text-xs text-center text-blue-600 dark:text-blue-400 font-medium">
              {checkedObjs.size} object{checkedObjs.size !== 1 ? "s" : ""} selected for export
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto text-sm">
          {!selected && (
            <div className="p-4 text-center text-gray-400 text-xs">
              Select a profile or perm set first.
            </div>
          )}
          {selected && !objsLoaded && !loadingObjs && (
            <div className="p-4 text-center text-gray-400 text-xs">
              Click <strong>Load Objects</strong>.
            </div>
          )}
          {filteredObjs.map((o) => {
            const isChecked = checkedObjs.has(o.apiName);
            const isActive  = selectedObj?.apiName === o.apiName;
            return (
              <div
                key={o.apiName}
                className={`flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 dark:border-gray-700 cursor-pointer select-none ${
                  isActive
                    ? "bg-blue-50 dark:bg-blue-900/30"
                    : isChecked
                    ? "bg-green-50 dark:bg-green-900/20"
                    : "hover:bg-white dark:hover:bg-gray-800"
                }`}
              >
                {/* Checkbox — toggles export selection */}
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleCheck(o.apiName)}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 accent-blue-600 cursor-pointer"
                />
                {/* Label — clicking loads FLS preview */}
                <div
                  className="flex-1 min-w-0"
                  onClick={() => { setSelectedObj(o); loadFls(o); }}
                >
                  <div className={`font-medium truncate text-xs ${isChecked ? "text-green-700 dark:text-green-300" : ""}`}>
                    {o.label}
                  </div>
                  <div className="text-xs text-gray-400 truncate">{o.apiName}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Right panel: FLS detail ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Object-level perms banner */}
        {flsData && (
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700 flex items-center gap-6 shrink-0 flex-wrap">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 mr-2">
              Object Perms:
            </span>
            {OBJ_PERMS.map(([label, key]) => {
              const granted = flsData.obj_perms?.[key];
              return (
                <span
                  key={key}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    granted
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : "bg-red-50 text-red-400 dark:bg-red-900/20 dark:text-red-400 line-through"
                  }`}
                >
                  {label}
                </span>
              );
            })}
          </div>
        )}

        {/* FLS table header */}
        <div className={`flex flex-col ${debugOpen ? "h-3/4" : "flex-1"} overflow-hidden`}>
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between shrink-0 gap-2">
            <span className="text-sm text-gray-500">
              {loadingFls
                ? <Spinner label="Loading FLS…" />
                : flsData
                  ? `${filteredFields.length} field permission entries — ${selectedObj?.label}`
                  : selected
                    ? "Select an object to view FLS"
                    : "Select a profile or perm set from the sidebar"
              }
            </span>
            <div className="flex items-center gap-2">
              {flsData && (
                <input
                  className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 w-40"
                  placeholder="Filter fields…"
                  value={fieldFilter}
                  onChange={(e) => { setFieldFilter(e.target.value); setFieldPage(0); }}
                />
              )}
              {filteredFields.length > FIELD_PAGE_SIZE && (
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <span>{fieldPage * FIELD_PAGE_SIZE + 1}–{Math.min((fieldPage + 1) * FIELD_PAGE_SIZE, filteredFields.length)} of {filteredFields.length}</span>
                  <button disabled={fieldPage === 0} onClick={() => setFieldPage((p) => p - 1)}
                    className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700">◀</button>
                  <button disabled={(fieldPage + 1) * FIELD_PAGE_SIZE >= filteredFields.length} onClick={() => setFieldPage((p) => p + 1)}
                    className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700">▶</button>
                </div>
              )}
            </div>
          </div>

          {/* FLS table */}
          <div className="flex-1 overflow-auto">
            {flsData && pagedFields.length > 0 && (
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider">
                  <tr>
                    <th className="px-3 py-2">Field API Name</th>
                    <th className="px-3 py-2 text-center w-24">Readable</th>
                    <th className="px-3 py-2 text-center w-24">Editable</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedFields.map((f, i) => (
                    <tr key={f.fname} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-800/50"}>
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300">{f.fname}</td>
                      <td className="px-3 py-1.5 text-center text-lg leading-none">
                        {f.readable
                          ? <span className="text-green-500">✓</span>
                          : <span className="text-red-300">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center text-lg leading-none">
                        {f.editable
                          ? <span className="text-green-500">✓</span>
                          : <span className="text-red-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {flsData && allFields.length === 0 && (
              <div className="p-8 text-center text-gray-400 text-sm">
                No field permission entries found for this principal × object combination.
              </div>
            )}
          </div>
        </div>

        {/* ── Debug log ─────────────────────────────────────────────────────── */}
        <div className={`border-t-2 border-gray-300 dark:border-gray-600 flex flex-col ${debugOpen ? "h-1/4" : "h-auto"}`}>
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="flex items-center justify-between px-4 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs font-mono font-semibold text-gray-600 dark:text-gray-300 transition-colors w-full text-left"
          >
            <span>🔍 Debug Log {debugLog.length > 0 && `(${debugLog.length})`}</span>
            <span className="text-gray-400">{debugOpen ? "▼ collapse" : "▲ expand"}</span>
          </button>
          {debugOpen && (
            <div className="flex-1 overflow-y-auto bg-gray-900 px-3 py-2 font-mono text-xs">
              {debugLog.length === 0
                ? <span className="text-gray-500">No log entries yet.</span>
                : debugLog.map((e, i) => (
                  <div key={i} className="flex gap-2 leading-5">
                    <span className="text-gray-500 shrink-0">{e.ts}</span>
                    <span className="shrink-0">{e.icon}</span>
                    <span className="text-green-300 break-all">{e.msg}</span>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
