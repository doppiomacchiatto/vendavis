import { useState, useCallback, useEffect, useRef } from "react";
import OrgPickerModal from "./components/OrgPickerModal";
import TabBar from "./components/TabBar";
import FlsExplorer from "./pages/FlsExplorer";
import ProfilesExplorer from "./pages/ProfilesExplorer";
import SoqlRunner from "./pages/SoqlRunner";
import ApexRunner from "./pages/ApexRunner";
import ClaudeChat from "./pages/ClaudeChat";
import OrgHealth from "./pages/OrgHealth";
import RestExplorer from "./pages/RestExplorer";
import DebugLogModal from "./components/DebugLogModal";
import WelcomeModal, { shouldShowWelcome } from "./components/WelcomeModal";
import { api } from "./api/client";
import { debugLog, useDebugLog } from "./debugLog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const TABS = [
  { id: "fls",      label: "🔍 FLS Explorer"       },
  { id: "profiles", label: "👤 Profiles & PermSets" },
  { id: "soql",     label: "⚡ SOQL Runner"         },
  { id: "apex",     label: "🏃 Apex Runner"         },
  { id: "health",   label: "🏥 Health"              },
  { id: "rest",     label: "🔬 REST Explorer"       },
  { id: "claude",   label: "🤖 OpenCode"            },
];

export default function App() {
  const [activeOrg,     setActiveOrg]     = useState(null);
  const [showOrgPicker, setShowOrgPicker] = useState(true);
  const [activeTab,     setActiveTab]     = useState("fls");
  const [orgContext,    setOrgContext]     = useState({ objects: [], fields: {}, objectsLoading: false, objectsLoaded: false });
  const [apiLimits,     setApiLimits]     = useState(null);   // {used, max}
  const [limitsError,   setLimitsError]   = useState("");
  const [limitsOpen,    setLimitsOpen]    = useState(false);
  const [debugOpen,     setDebugOpen]     = useState(false);
  const debugEntries = useDebugLog();

  // ── Quit confirm modal ─────────────────────────────────────────────────────
  const [quitConfirm,   setQuitConfirm]   = useState(false);

  // Listen for Tauri window events
  useEffect(() => {
    let unlistenClose, unlistenAbout;
    // Close button → show confirm dialog
    listen("app:close-requested", () => {
      setQuitConfirm(true);
    }).then((fn) => { unlistenClose = fn; });
    // macOS "About Avio" menu item → open our in-app About modal
    listen("app:open-about", () => {
      setHelpTab("about");
      setAboutOpen(true);
    }).then((fn) => { unlistenAbout = fn; });
    return () => {
      if (unlistenClose) unlistenClose();
      if (unlistenAbout) unlistenAbout();
    };
  }, []);

  async function handleQuitYes() {
    setQuitConfirm(false);
    await invoke("confirm_close");
  }

  function handleQuitNo() {
    setQuitConfirm(false);
  }

  // ── Welcome modal (shown once on first launch) ────────────────────────────
  const [welcomeOpen, setWelcomeOpen] = useState(() => shouldShowWelcome());

  // ── Restart backend modal ──────────────────────────────────────────────────
  // phase: "idle" | "restarting" | "done" | "error"
  const [restartPhase, setRestartPhase] = useState("idle");
  const [restartError, setRestartError] = useState(null);

  async function handleRestartBackend() {
    setRestartPhase("restarting");
    setRestartError(null);
    try {
      await invoke("restart_backend");
      setRestartPhase("done");
    } catch (e) {
      const raw = String(e);
      const friendly = raw.includes("seconds")
        ? "Backend did not come back online in time. Try quitting and relaunching the app."
        : `Could not restart backend: ${raw}`;
      setRestartError(friendly);
      setRestartPhase("error");
    }
  }

  function closeRestartModal() {
    setRestartPhase("idle");
    setRestartError(null);
  }

  // ── App version (read from Tauri at startup) ───────────────────────────────
  const [appVersion, setAppVersion] = useState("1.0.1");
  useEffect(() => {
    if (window.__TAURI__) {
      import("@tauri-apps/api/app").then(({ getVersion }) =>
        getVersion().then(setAppVersion).catch(() => {})
      ).catch(() => {});
    }
  }, []);

  // ── Settings modal ─────────────────────────────────────────────────────────
  const [aboutOpen,     setAboutOpen]     = useState(false);
  const [helpTab,       setHelpTab]       = useState("about"); // "about" | "requirements"

  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({ api_key: "", model: "", base_url: "", skills_enabled: true, skills_source: "bundled", skills_path: "", skills_url: "" });
  const [skillsTest,    setSkillsTest]    = useState(null);   // null | "testing" | { ok, msg, skills, version }
  const [skillsOpen,    setSkillsOpen]    = useState(false);  // skills section expanded
  const [availModels,   setAvailModels]   = useState([]);
  const [providers,     setProviders]     = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsNote,    setModelsNote]    = useState("");
  const [settingsSaved, setSettingsSaved] = useState("");   // "" | "saved" | "error:<msg>"
  const [settingsKeySet,setSettingsKeySet]= useState(false);
  const [settingsKeySource, setSettingsKeySource] = useState("none"); // "avio"|"legacy"|"none"

  // Fetch current settings when modal opens
  useEffect(() => {
    if (!settingsOpen) return;
    api("/api/settings").then((d) => {
      setSettingsDraft({
        api_key: "", model: d.model || "", base_url: d.base_url || "",
        skills_enabled: d.skills_enabled !== false,
        skills_source:  d.skills_source  || "bundled",
        skills_path:    d.skills_path    || "",
        skills_url:     d.skills_url     || "",
      });
      setAvailModels(d.models || []);
      setProviders(d.providers || []);
      setSettingsKeySet(d.key_set || false);
      setSettingsKeySource(d.key_source || "none");
      setSkillsTest(null);
      if (d.key_set) refreshModels({ base_url: d.base_url || "" });
    }).catch(() => {});
  }, [settingsOpen]);

  const normUrl = (u) => (u || "").trim().replace(/\/+$/, "");
  const activeProvider =
    providers.find((p) => p.base_url && normUrl(p.base_url) === normUrl(settingsDraft.base_url))
    || (settingsDraft.base_url ? providers.find((p) => p.id === "custom") : null);

  function pickProvider(id) {
    const p = providers.find((x) => x.id === id);
    const base_url = p ? (p.id === "custom" ? settingsDraft.base_url : p.base_url) : "";
    const next = { ...settingsDraft, base_url };
    setSettingsDraft(next);
    if (p && p.id !== "custom") refreshModels(next);
  }

  // Ask the backend for the provider's live model list (uses unsaved form values if given)
  async function refreshModels(draft = settingsDraft) {
    setModelsLoading(true);
    setModelsNote("");
    try {
      const d = await api("/api/models", {
        method: "POST",
        body: JSON.stringify({ api_key: draft.api_key || null, base_url: draft.base_url || null }),
      });
      setAvailModels(d.models || []);
      setModelsNote(d.source === "live"
        ? `${(d.models || []).length} models from your provider`
        : `Couldn't fetch models — showing built-in list${d.error ? ` (${d.error.split("\n")[0]})` : ""}`);
      debugLog(`models: ${d.source}${d.error ? ` — ${d.error}` : ` (${(d.models || []).length})`}`, d.source === "live" ? "done" : "warn");
    } catch (e) {
      setModelsNote(`Couldn't fetch models: ${e.message.split("\n")[0]}`);
    } finally {
      setModelsLoading(false);
    }
  }

  async function saveSettings() {
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          api_key:        settingsDraft.api_key,
          model:          settingsDraft.model,
          base_url:       settingsDraft.base_url,
          skills_enabled: settingsDraft.skills_enabled,
          skills_source:  settingsDraft.skills_source,
          skills_path:    settingsDraft.skills_path,
          skills_url:     settingsDraft.skills_url,
        }),
      });
      setSettingsSaved("saved");
      setTimeout(() => { setSettingsSaved(""); setSettingsOpen(false); }, 900);
    } catch (e) {
      setSettingsSaved(`error:${e.message}`);
    }
  }

  async function testSkillsConnection() {
    setSkillsTest("testing");
    try {
      const d = await api("/api/ai/skills");
      const active = (d.skills || []).filter(s => s.available);
      if (active.length === 0) {
        setSkillsTest({ ok: false, msg: "No skill files found at the configured location.", skills: d.skills || [], version: d.version || {} });
      } else {
        setSkillsTest({ ok: true, msg: `${active.length} of ${d.skills.length} skill${d.skills.length > 1 ? "s" : ""} available`, skills: d.skills || [], version: d.version || {} });
      }
    } catch (e) {
      setSkillsTest({ ok: false, msg: e.message, skills: [], version: {} });
    }
  }

  function handleOrgSelect(org) {
    setActiveOrg(org);
    setOrgContext({ objects: [], fields: {}, objectsLoading: false, objectsLoaded: false });
    setApiLimits(null);
    setShowOrgPicker(false);
  }

  // ── Shared lazy object loader ───────────────────────────────────────────────
  // Tabs call loadObjects() — fetches once per org, caches in orgContext.objects.
  // A ref guards against concurrent calls (React state isn't synchronous enough).
  const objectsFetchingRef = useRef(false);

  const loadObjects = useCallback(async () => {
    if (!activeOrg) return { status: "no_org" };
    // Guard: already loaded, already in-flight, or concurrent call
    if (orgContext.objectsLoaded || orgContext.objectsLoading || objectsFetchingRef.current) {
      const reason = orgContext.objectsLoaded ? "already loaded" : "already in flight";
      debugLog(`load_objects skipped for ${activeOrg.alias} (${reason})`, "warn");
      return { status: "skipped", reason, count: orgContext.objects.length };
    }
    objectsFetchingRef.current = true;
    setOrgContext(ctx => ({ ...ctx, objectsLoading: true }));

    const t0 = performance.now();
    const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
    debugLog(`load_objects called for ${activeOrg.alias}`, "start");
    const heartbeat = setInterval(() => debugLog(`load_objects still running… ${secs()}s`, "warn"), 10000);

    try {
      const d = await api(`/api/orgs/${activeOrg.alias}/objects`);
      const objs = d.objects || [];
      setOrgContext(ctx => ({ ...ctx, objects: objs, objectsLoaded: true, objectsLoading: false }));
      debugLog(`load_objects finished for ${activeOrg.alias}: ${objs.length} objects in ${secs()}s`, "done");
      return { status: "loaded", count: objs.length, secs: secs() };
    } catch (e) {
      setOrgContext(ctx => ({ ...ctx, objectsLoading: false }));
      debugLog(`load_objects failed for ${activeOrg.alias} after ${secs()}s: ${e.message}`, "error");
      return { status: "error", error: e.message, secs: secs() };
    } finally {
      clearInterval(heartbeat);
      objectsFetchingRef.current = false;
    }
  }, [activeOrg, orgContext.objectsLoaded, orgContext.objectsLoading]);

  const fetchLimits = useCallback(async (org) => {
    const target = org || activeOrg;
    if (!target) return;
    try {
      const ldata = await api(`/api/orgs/${target.alias}/limits`);
      setApiLimits(ldata.dailyApiRequests);
      setLimitsError("");
    } catch (e) {
      setLimitsError(e.message);
    }
  }, [activeOrg]);

  const pct = apiLimits ? Math.round((apiLimits.used / apiLimits.max) * 100) : 0;
  const pctColor = pct > 80 ? "text-red-400" : pct > 50 ? "text-yellow-400" : "text-green-400";

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Org picker modal */}
      {showOrgPicker && <OrgPickerModal onSelect={handleOrgSelect} />}

      {welcomeOpen && <WelcomeModal onClose={() => setWelcomeOpen(false)} />}

      {debugOpen && <DebugLogModal onClose={() => setDebugOpen(false)} />}

      {/* Quit confirm modal */}
      {quitConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100]">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[380px] p-8 flex flex-col gap-6">
            {/* Icon + heading */}
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-3xl">
                ⚠️
              </div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Stop background processes?</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                Avio is running a local data service. Closing the app will stop it — any in-progress exports or queries will be cancelled.
              </p>
            </div>
            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={handleQuitNo}
                className="flex-1 py-2.5 rounded-xl border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleQuitYes}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold text-sm transition-colors"
              >
                Stop &amp; Quit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 py-2 bg-[#1a2d5a] text-white shadow-md select-none">
        <div className="flex items-center gap-2">
          <img src="/icon-32.png" alt="Avio" className="w-6 h-6 object-contain" />
          <span className="font-bold text-lg tracking-tight">Avio</span>
        </div>
        <span className="text-xs text-blue-300 font-normal tracking-wide">Unofficial Salesforce Tool</span>
        <div className="ml-auto flex items-center gap-3">
          {activeOrg && (
            <span className="text-sm text-blue-200">
              {activeOrg.alias}
              <span className="text-blue-300 text-xs ml-1">({activeOrg.username})</span>
            </span>
          )}
          <button
            onClick={() => setShowOrgPicker(true)}
            className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors"
          >
            {activeOrg ? "Switch Org" : "Select Org"}
          </button>
          {/* Help dropdown */}
          <div className="relative" onMouseLeave={() => {}}>
            <div className="group relative">
              <button
                className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors"
              >
                Help ▾
              </button>
              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden
                opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150">
                <button
                  onClick={() => setWelcomeOpen(true)}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  Getting Started
                </button>
                <div className="border-t border-gray-100 dark:border-gray-700" />
                <button
                  onClick={() => { setHelpTab("about"); setAboutOpen(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  About Avio
                </button>
                <div className="border-t border-gray-100 dark:border-gray-700" />
                <button
                  onClick={() => { setHelpTab("overview"); setAboutOpen(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  Architecture Overview
                </button>
                <div className="border-t border-gray-100 dark:border-gray-700" />
                <button
                  onClick={() => { setHelpTab("requirements"); setAboutOpen(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  Pre-Requisites
                </button>
              </div>
            </div>
          </div>
          <button
            onClick={() => invoke("open_file", { path: `http://localhost:${window.__SF_BACKEND_PORT__ || 7891}/docs` })}
            className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors font-mono"
            title="Open FastAPI Swagger docs in browser"
          >
            API
          </button>
          <button
            onClick={handleRestartBackend}
            disabled={restartPhase === "restarting"}
            title="Restart the Python backend service"
            className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 border border-blue-400 rounded px-3 py-1 transition-colors"
          >
            Restart Backend
          </button>
          <button
            onClick={() => setDebugOpen(true)}
            className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors"
            title="Debug log"
          >
            🐞 Debug{debugEntries.length > 0 && ` (${debugEntries.length})`}
          </button>
          <button
            onClick={() => { setSettingsSaved(""); setSettingsOpen(true); }}
            className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors"
            title="AI Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      {/* Restart backend modal */}
      {restartPhase !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={restartPhase !== "restarting" ? closeRestartModal : undefined} />
          <div className="relative w-full max-w-sm rounded-2xl border border-slate-600/60 bg-slate-900 shadow-2xl overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-700/60 bg-[#1a2d5a]">
              <span className="text-xl">⚙️</span>
              <p className="text-sm font-semibold text-white">Restart Backend</p>
            </div>

            {/* Body */}
            <div className="px-6 py-6 flex flex-col items-center gap-4 text-center">
              {restartPhase === "restarting" && (
                <>
                  <div className="w-12 h-12 rounded-full border-4 border-blue-500/30 border-t-blue-400 animate-spin" />
                  <div>
                    <p className="text-sm font-semibold text-white">Restarting backend…</p>
                    <p className="text-xs text-slate-400 mt-1">Waiting for the service to come back online.</p>
                  </div>
                </>
              )}
              {restartPhase === "done" && (
                <>
                  <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center text-2xl">✅</div>
                  <div>
                    <p className="text-sm font-semibold text-white">Backend restarted</p>
                    <p className="text-xs text-slate-400 mt-1">The service is back online. All features are ready to use.</p>
                  </div>
                </>
              )}
              {restartPhase === "error" && (
                <>
                  <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center text-2xl">❌</div>
                  <div>
                    <p className="text-sm font-semibold text-white">Restart failed</p>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">{restartError}</p>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {restartPhase !== "restarting" && (
              <div className="px-6 py-4 border-t border-slate-700/60 flex justify-end">
                <button
                  onClick={closeRestartModal}
                  className="px-5 py-1.5 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab bar */}
      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      {/* Page content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === "fls"      && <FlsExplorer      org={activeOrg} ctx={orgContext} setCtx={setOrgContext} loadObjects={loadObjects} onApiCall={() => fetchLimits()} />}
        {activeTab === "profiles" && <ProfilesExplorer org={activeOrg} ctx={orgContext} setCtx={setOrgContext} loadObjects={loadObjects} onApiCall={() => fetchLimits()} />}
        {activeTab === "soql"     && <SoqlRunner        org={activeOrg} ctx={orgContext} setCtx={setOrgContext} loadObjects={loadObjects} onApiCall={() => fetchLimits()} />}
        {activeTab === "apex"     && <ApexRunner  org={activeOrg} onApiCall={() => fetchLimits()} />}
        {activeTab === "health"   && <OrgHealth   org={activeOrg} onApiCall={() => fetchLimits()} />}
        {activeTab === "rest"     && <RestExplorer org={activeOrg} />}
        {activeTab === "claude"   && <ClaudeChat  org={activeOrg} ctx={orgContext} setCtx={setOrgContext} />}
      </main>

      {/* Global footer — API limit status bar */}
      {activeOrg && (
        <footer className="shrink-0 flex items-center justify-end gap-2 px-4 py-1.5 bg-blue-900 border-t border-blue-700 text-xs font-mono select-none">
          {limitsError ? (
            <span className="text-red-400" title={limitsError}>⚠ Limits unavailable</span>
          ) : apiLimits ? (
            <>
              <span className="text-blue-200">Org API calls</span>
              <span className={`font-semibold ${pctColor}`}>
                {apiLimits.used.toLocaleString()} / {apiLimits.max.toLocaleString()}
              </span>
              <span className="text-blue-300">({pct}%)</span>
            </>
          ) : (
            <span className="text-blue-300">Org API calls —</span>
          )}
          <button onClick={() => fetchLimits()} className="text-blue-300 hover:text-white transition-colors" title="Refresh">↻</button>
          <button onClick={() => setLimitsOpen(true)} className="text-blue-300 hover:text-white transition-colors font-bold" title="About API limits">?</button>
        </footer>
      )}

      {/* ── Help modal ───────────────────────────────────────────────────────── */}
      {aboutOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setAboutOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Hero banner */}
            <div className="bg-[#1a2d5a] px-6 pt-6 pb-0">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <img src="/icon-32.png" alt="Avio" className="w-8 h-8 object-contain" />
                    <h2 className="text-xl font-bold text-white tracking-tight">Avio</h2>
                  </div>
                  <p className="text-xs text-blue-200 italic leading-relaxed">
                    From Latin <span className="text-blue-100 font-medium">vendo</span> (to reveal, expose) + <span className="text-blue-100 font-medium">avis</span> (bird, explorer)
                    <br />— the scout that brings hidden structure into the light.
                  </p>
                </div>
                <button onClick={() => setAboutOpen(false)} className="text-blue-300 hover:text-white text-lg leading-none mt-0.5">✕</button>
              </div>
              {/* Tabs */}
              <div className="flex gap-1">
                {[["about", "About"], ["overview", "Overview"], ["requirements", "Requirements"]].map(([id, label]) => (
                  <button key={id} onClick={() => setHelpTab(id)}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                      helpTab === id
                        ? "bg-white dark:bg-gray-900 text-[#1a2d5a] dark:text-blue-400"
                        : "text-blue-200 hover:text-white"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab: About */}
            {helpTab === "about" && (
              <div className="px-6 py-5 flex flex-col gap-4 text-sm text-gray-600 dark:text-gray-300">
                {/* Latin meaning + version */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-3">
                      <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 tracking-wide uppercase">Etymology</p>
                    </div>
                    <div className="flex gap-4 text-xs">
                      <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800">
                        <span className="font-bold text-blue-700 dark:text-blue-300 text-sm">avis</span>
                        <span className="text-blue-500 dark:text-blue-400 italic mt-0.5">Latin — bird</span>
                      </div>
                      <div className="flex items-center text-gray-400 text-lg font-light">→</div>
                      <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800">
                        <span className="font-bold text-blue-700 dark:text-blue-300 text-sm">Avio</span>
                        <span className="text-blue-500 dark:text-blue-400 italic mt-0.5">the scout</span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 italic leading-relaxed mt-0.5">
                      A scout that sees what others can't — bringing hidden Salesforce structure into the light.
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded self-start">v{appVersion} Beta</span>
                </div>
                <p className="leading-relaxed">
                  An unofficial Salesforce metadata explorer — built for teams who need to understand exactly what their org allows and why, without spending hours in Setup.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    ["🔍", "FLS Explorer",        "Audit field access across profiles"],
                    ["👤", "Profiles & PermSets",  "Compare permissions side by side"],
                    ["📊", "SOQL Runner",          "Query any object with AI assist"],
                    ["⚙️", "Apex Runner",          "Execute and iterate anonymous Apex"],
                    ["🏥", "Org Health",           "35 checks across 7 categories"],
                    ["🔬", "REST Explorer",        "Browse any Salesforce REST endpoint"],
                    ["🤖", "OpenCode AI",          "Natural language Salesforce help"],
                  ].map(([icon, name, desc]) => (
                    <div key={name} className="flex gap-2 p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                      <span className="shrink-0 text-base">{icon}</span>
                      <div>
                        <p className="font-semibold text-gray-800 dark:text-gray-100">{name}</p>
                        <p className="text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">{desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700 pt-3">
                  Unofficial tool — not affiliated with Salesforce. Read-only by default; no data is modified unless explicitly committed.
                </p>
                {/* Easter egg — with gratitude */}
                <p className="text-xs text-gray-300 dark:text-gray-600 text-center tracking-wide pt-1 select-none" title="with gratitude 🐦">
                  ✦ Carlos · Tyler · Bruce ✦
                </p>
              </div>
            )}

            {/* Tab: Overview */}
            {helpTab === "overview" && (
              <div className="px-6 py-5 flex flex-col gap-5 text-sm text-gray-600 dark:text-gray-300 max-h-[70vh] overflow-y-auto">

                {/* Architecture diagram */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">Architecture</p>
                  <div className="flex flex-col gap-1.5">
                    {/* Frontend layer */}
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
                      <span className="text-xl shrink-0">🖥️</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-800 dark:text-white text-sm">Frontend <span className="font-normal text-gray-500 dark:text-gray-400 text-xs ml-1">React + Vite + Tailwind</span></p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Renders the UI in a Tauri WebView. Sends all API calls to the local backend over localhost — no data ever leaves your machine.</p>
                      </div>
                    </div>
                    {/* Arrow */}
                    <div className="flex justify-center text-gray-300 dark:text-gray-600 text-sm leading-none">↕ localhost REST</div>
                    {/* Backend layer */}
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                      <span className="text-xl shrink-0">⚙️</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-800 dark:text-white text-sm">Backend <span className="font-normal text-gray-500 dark:text-gray-400 text-xs ml-1">Python · FastAPI · uvicorn</span></p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Runs as a bundled binary on a random local port. Handles Salesforce CLI calls, Excel exports, SOQL, Apex execution, and OpenCode AI requests.</p>
                      </div>
                    </div>
                    {/* Arrow */}
                    <div className="flex justify-center text-gray-300 dark:text-gray-600 text-sm leading-none">↕ subprocess</div>
                    {/* SF CLI layer */}
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800">
                      <span className="text-xl shrink-0">☁️</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-800 dark:text-white text-sm">Salesforce CLI <span className="font-normal text-gray-500 dark:text-gray-400 text-xs ml-1">sf / sfdx</span></p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">The backend shells out to your locally-installed <code className="font-mono bg-green-100 dark:bg-green-900/40 px-1 rounded">sf</code> CLI to authenticate and query Salesforce. All API calls go through the CLI using your existing authenticated sessions.</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Key facts */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">How it works</p>
                  <div className="flex flex-col gap-2">
                    {[
                      ["🔐", "Authentication", "Avio never stores your Salesforce credentials. It uses the sessions you've already authenticated with the sf CLI — run sf org login web to add a new org."],
                      ["📡", "Data flow", "All Salesforce data stays on your machine. The backend calls the sf CLI, which calls Salesforce's REST API, then returns the result to the frontend. Nothing is sent to any third-party server."],
                      ["🤖", "OpenCode AI", "AI features connect to the OpenCode gateway (or any OpenAI-compatible provider) using the API key in Settings. Org metadata is included in the prompt only when you actively use an AI feature."],
                      ["📦", "Bundled runtime", "The Python backend is compiled into a self-contained binary by PyInstaller — no Python installation required on the end-user machine."],
                    ].map(([icon, title, desc]) => (
                      <div key={title} className="flex gap-3 text-xs">
                        <span className="shrink-0 mt-0.5">{icon}</span>
                        <div>
                          <span className="font-semibold text-gray-700 dark:text-gray-200">{title} — </span>
                          <span className="text-gray-500 dark:text-gray-400">{desc}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Tech stack summary */}
                <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100 dark:border-gray-700">
                  {[
                    ["Tauri v2", "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"],
                    ["React 18", "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"],
                    ["FastAPI", "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300"],
                    ["Python 3.9", "bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300"],
                    ["PyInstaller", "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"],
                    ["Salesforce CLI", "bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300"],
                  ].map(([name, cls]) => (
                    <span key={name} className={`text-xs px-2.5 py-1 rounded-full font-medium ${cls}`}>{name}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Tab: Requirements */}
            {helpTab === "requirements" && (
              <div className="px-6 py-5 flex flex-col gap-4 text-sm text-gray-600 dark:text-gray-300">
                <div className="flex flex-col gap-3">
                  {/* SF CLI */}
                  <div className="flex gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                    <span className="text-xl shrink-0">🔧</span>
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold text-gray-800 dark:text-white text-sm">Salesforce CLI <span className="text-red-500 text-xs font-bold ml-1">Required</span></p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                        Avio uses the <code className="font-mono bg-gray-200 dark:bg-gray-700 px-1 rounded">sf</code> CLI to communicate with your Salesforce orgs. It must be installed and available on your system PATH.
                      </p>
                      <div className="mt-1 flex flex-col gap-1">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Install:</p>
                        <code className="text-xs bg-gray-900 text-green-400 px-2 py-1.5 rounded font-mono">npm install -g @salesforce/cli</code>
                      </div>
                      <div className="mt-1 flex flex-col gap-1">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Verify:</p>
                        <code className="text-xs bg-gray-900 text-green-400 px-2 py-1.5 rounded font-mono">sf --version</code>
                      </div>
                      <a href="https://developer.salesforce.com/tools/salesforcecli"
                        className="text-xs text-blue-500 hover:text-blue-600 mt-1 underline"
                        target="_blank" rel="noreferrer">
                        developer.salesforce.com/tools/salesforcecli →
                      </a>
                    </div>
                  </div>

                  {/* Authenticated org */}
                  <div className="flex gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                    <span className="text-xl shrink-0">🔑</span>
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold text-gray-800 dark:text-white text-sm">Authenticated Org <span className="text-red-500 text-xs font-bold ml-1">Required</span></p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                        At least one Salesforce org must be authenticated with the CLI before launching Avio.
                      </p>
                      <div className="mt-1 flex flex-col gap-1">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Authenticate:</p>
                        <code className="text-xs bg-gray-900 text-green-400 px-2 py-1.5 rounded font-mono">sf org login web</code>
                      </div>
                    </div>
                  </div>

                  {/* OpenCode API key */}
                  <div className="flex gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                    <span className="text-xl shrink-0">🤖</span>
                    <div className="flex flex-col gap-1">
                      <p className="font-semibold text-gray-800 dark:text-white text-sm">OpenCode API Key <span className="text-yellow-500 text-xs font-bold ml-1">Optional</span></p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                        Required only for the OpenCode tab, SOQL AI assist, and Apex AI assistant. Configure via <strong>⚙ Settings</strong> in the toolbar or in <code>opencode.config.json</code>.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Settings modal ───────────────────────────────────────────────────── */}
      {settingsOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setSettingsOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-800 dark:text-white">AI Settings</h2>
              <button onClick={() => setSettingsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">✕</button>
            </div>

            <div className="flex flex-col gap-4 text-sm">
              {/* Provider preset */}
              <label className="flex flex-col gap-1">
                <span className="font-medium text-gray-700 dark:text-gray-300">Provider</span>
                <select
                  value={activeProvider?.id || ""}
                  onChange={(e) => pickProvider(e.target.value)}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Auto (OpenCode key → OpenCode, otherwise OpenAI)</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>

              {/* API Key */}
              <label className="flex flex-col gap-1">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  API Key
                  {settingsKeySet && settingsKeySource === "avio" && (
                    <span className="ml-2 text-xs text-green-500 font-normal">✓ key saved</span>
                  )}
                  {settingsKeySet && settingsKeySource === "legacy" && (
                    <span className="ml-2 text-xs text-yellow-500 font-normal">✓ using key from SOQL Explorer config</span>
                  )}
                </span>
                <input
                  type="password"
                  placeholder={
                    activeProvider?.needs_key === false ? "Not needed for a local server"
                    : settingsKeySet ? "••••••••••••••••••••••••"
                    : activeProvider?.key_hint || "oc_sk_… (OpenCode) or sk-… (OpenAI)"
                  }
                  value={settingsDraft.api_key}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, api_key: e.target.value }))}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs"
                  autoComplete="off"
                />
              </label>

              {/* Gateway URL */}
              <label className="flex flex-col gap-1">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  Gateway URL
                  <span className="ml-1 text-xs text-gray-400 font-normal">(filled in by Provider; edit for a custom gateway)</span>
                </span>
                <input
                  type="text"
                  placeholder="https://…"
                  value={settingsDraft.base_url}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, base_url: e.target.value }))}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs"
                />
              </label>

              {/* Model picklist */}
              <label className="flex flex-col gap-1">
                <span className="font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2">
                  Model
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); refreshModels(); }}
                    disabled={modelsLoading}
                    className="text-xs font-normal text-blue-600 hover:text-blue-700 disabled:opacity-50"
                    title="Fetch the model list from your provider using the key and gateway above"
                  >
                    {modelsLoading ? "Fetching…" : "↻ Refresh list"}
                  </button>
                </span>
                <select
                  value={settingsDraft.model}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, model: e.target.value }))}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Default (from opencode.config.json or gpt-4o)</option>
                  {settingsDraft.model && !availModels.some((m) => m.id === settingsDraft.model) && (
                    <option value={settingsDraft.model}>{settingsDraft.model} (current)</option>
                  )}
                  {availModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                {modelsNote && <span className="text-xs text-gray-400">{modelsNote}</span>}
              </label>
            </div>

            {/* Skills section */}
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              {/* Collapsible header */}
              <button
                type="button"
                onClick={() => setSkillsOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200">🧠 Salesforce Skills</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    settingsDraft.skills_enabled
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                  }`}>
                    {settingsDraft.skills_enabled ? "On" : "Off"}
                  </span>
                </div>
                <span className="text-gray-400 text-xs">{skillsOpen ? "▲" : "▼"}</span>
              </button>

              {skillsOpen && (
                <div className="px-4 py-4 flex flex-col gap-3 text-sm border-t border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                    When enabled, Avio automatically injects official Salesforce guidance (from{" "}
                    <span className="font-mono text-gray-600 dark:text-gray-300">forcedotcom/sf-skills</span>)
                    into AI chat responses when it detects SOQL or Apex questions.
                  </p>

                  {/* Enable / disable toggle */}
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div
                      onClick={() => setSettingsDraft(d => ({ ...d, skills_enabled: !d.skills_enabled }))}
                      className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                        settingsDraft.skills_enabled ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
                      }`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                        settingsDraft.skills_enabled ? "translate-x-5" : "translate-x-0.5"
                      }`} />
                    </div>
                    <span className="text-gray-700 dark:text-gray-300 font-medium">
                      {settingsDraft.skills_enabled ? "Enabled" : "Disabled"}
                    </span>
                  </label>

                  {/* Source picker */}
                  <label className="flex flex-col gap-1">
                    <span className="font-medium text-gray-700 dark:text-gray-300">Source</span>
                    <select
                      value={settingsDraft.skills_source}
                      onChange={e => setSettingsDraft(d => ({ ...d, skills_source: e.target.value }))}
                      disabled={!settingsDraft.skills_enabled}
                      className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                    >
                      <option value="bundled">Bundled — shipped with this version of Avio</option>
                      <option value="path">Local path — internal mirror or network share</option>
                      <option value="url">Internal URL — internal HTTP skills server</option>
                    </select>
                  </label>

                  {/* Path input (shown for "path" source) */}
                  {settingsDraft.skills_source === "path" && (
                    <label className="flex flex-col gap-1">
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        Skills directory path
                        <span className="ml-1 text-xs text-gray-400 font-normal">(root of sf-skills checkout or mirror)</span>
                      </span>
                      <input
                        type="text"
                        placeholder="/mnt/internal/sf-skills  or  ~/sf-skills"
                        value={settingsDraft.skills_path}
                        onChange={e => setSettingsDraft(d => ({ ...d, skills_path: e.target.value }))}
                        disabled={!settingsDraft.skills_enabled}
                        className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs disabled:opacity-50"
                      />
                    </label>
                  )}

                  {/* URL input (shown for "url" source) */}
                  {settingsDraft.skills_source === "url" && (
                    <label className="flex flex-col gap-1">
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        Internal skills URL
                        <span className="ml-1 text-xs text-gray-400 font-normal">(root of internal sf-skills HTTP mirror)</span>
                      </span>
                      <input
                        type="text"
                        placeholder="https://skills.internal.corp/sf-skills"
                        value={settingsDraft.skills_url}
                        onChange={e => setSettingsDraft(d => ({ ...d, skills_url: e.target.value }))}
                        disabled={!settingsDraft.skills_enabled}
                        className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs disabled:opacity-50"
                      />
                    </label>
                  )}

                  {/* Test connection */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={testSkillsConnection}
                      disabled={!settingsDraft.skills_enabled || skillsTest === "testing"}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                    >
                      {skillsTest === "testing" ? "Testing…" : "Test connection"}
                    </button>
                    {skillsTest && skillsTest !== "testing" && (
                      <span className={`text-xs ${skillsTest.ok ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                        {skillsTest.ok ? "✓ " : "✗ "}{skillsTest.msg}
                      </span>
                    )}
                  </div>

                  {/* Skills list — shown after a successful test */}
                  {skillsTest && skillsTest !== "testing" && skillsTest.skills && skillsTest.skills.length > 0 && (
                    <div className="flex flex-col gap-2 pt-1">
                      {skillsTest.version?.commit && (
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          forcedotcom/sf-skills{" "}
                          <span className="font-mono">{skillsTest.version.commit}</span>
                          {skillsTest.version.date && ` · ${skillsTest.version.date}`}
                        </p>
                      )}
                      {skillsTest.skills.map(s => (
                        <div key={s.name} className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-xs ${
                          s.available
                            ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                            : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 opacity-60"
                        }`}>
                          <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${s.available ? "bg-green-500" : "bg-gray-400"}`} />
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-semibold text-gray-800 dark:text-gray-200">{s.label}</span>
                            <span className="text-gray-500 dark:text-gray-400 leading-snug">{s.description}</span>
                          </div>
                          {s.available && (
                            <span className="ml-auto shrink-0 text-gray-400 dark:text-gray-500 font-mono">
                              {s.file_count} file{s.file_count !== 1 ? "s" : ""}
                            </span>
                          )}
                          {!s.available && (
                            <span className="ml-auto shrink-0 text-gray-400 italic">not found</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 dark:border-gray-700">
              {settingsSaved === "saved" && (
                <span className="text-green-500 text-sm font-medium mr-auto">✓ Saved!</span>
              )}
              {settingsSaved.startsWith("error:") && (
                <span className="text-red-500 text-xs mr-auto">{settingsSaved.slice(6)}</span>
              )}
              <button
                onClick={() => setSettingsOpen(false)}
                className="px-4 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                className="px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Limits modal */}
      {limitsOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setLimitsOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-800 dark:text-white">Salesforce API Limits</h2>
              <button onClick={() => setLimitsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">✕</button>
            </div>
            <div className="flex flex-col gap-3 text-sm text-gray-600 dark:text-gray-300">
              <p>
                <strong className="text-gray-800 dark:text-white">Daily API Requests</strong> is Salesforce's main governor limit.
                Every REST API call, SOQL query via the API, and Apex execution counts against your org's daily allocation. The limit resets at midnight GMT.
              </p>
              <p><strong className="text-gray-800 dark:text-white">How Avio uses API calls:</strong></p>
              <ul className="flex flex-col gap-1.5 pl-4 text-xs">
                {[
                  ["Load Objects",            "1 call — sf data query (EntityDefinition)"],
                  ["Load Profiles / PermSets", "1 call — sf data query (Profile or PermissionSet)"],
                  ["View FLS for an object",  "2 calls — FieldPermissions + ObjectPermissions"],
                  ["Export (per profile)",    "3 calls — FieldPermissions bulk, EntityParticle bulk, EntityDefinition labels"],
                  ["Execute Apex",            "1 call — sf apex run + 1 call to fetch updated limits"],
                  ["Load Fields",             "1 call — sf sobject describe"],
                ].map(([action, cost]) => (
                  <li key={action} className="flex gap-2">
                    <span className="shrink-0 text-blue-500">▸</span>
                    <span><strong className="text-gray-700 dark:text-gray-200">{action}</strong> — {cost}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3">
                💡 Most orgs have 15,000–1,000,000+ daily API calls depending on their Salesforce edition and add-ons.
                If you hit the limit, all API calls return a 403 error until midnight GMT.
                Avio caches FLS data in memory for 5 minutes to minimise repeat calls.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
