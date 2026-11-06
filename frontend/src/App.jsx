import { useState, useCallback, useEffect } from "react";
import OrgPickerModal from "./components/OrgPickerModal";
import TabBar from "./components/TabBar";
import FlsExplorer from "./pages/FlsExplorer";
import ProfilesExplorer from "./pages/ProfilesExplorer";
import SoqlRunner from "./pages/SoqlRunner";
import ApexRunner from "./pages/ApexRunner";
import ClaudeChat from "./pages/ClaudeChat";
import { api } from "./api/client";

const TABS = [
  { id: "fls",      label: "FLS Explorer"      },
  { id: "profiles", label: "Profiles & PermSets" },
  { id: "soql",     label: "SOQL Runner"        },
  { id: "apex",     label: "Apex Runner"        },
  { id: "claude",   label: "Claude AI"          },
];

export default function App() {
  const [activeOrg,     setActiveOrg]     = useState(null);
  const [showOrgPicker, setShowOrgPicker] = useState(true);
  const [activeTab,     setActiveTab]     = useState("fls");
  const [orgContext,    setOrgContext]     = useState({ objects: [], fields: {} });
  const [apiLimits,     setApiLimits]     = useState(null);   // {used, max}
  const [limitsError,   setLimitsError]   = useState("");
  const [limitsOpen,    setLimitsOpen]    = useState(false);

  // ── Settings modal ─────────────────────────────────────────────────────────
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({ api_key: "", model: "", base_url: "" });
  const [availModels,   setAvailModels]   = useState([]);
  const [settingsSaved, setSettingsSaved] = useState("");   // "" | "saved" | "error:<msg>"
  const [settingsKeySet,setSettingsKeySet]= useState(false);
  const [settingsKeySource, setSettingsKeySource] = useState("none"); // "vendavis"|"legacy"|"none"

  // Fetch current settings when modal opens
  useEffect(() => {
    if (!settingsOpen) return;
    api("/api/settings").then((d) => {
      setSettingsDraft({ api_key: "", model: d.model || "", base_url: d.base_url || "" });
      setAvailModels(d.models || []);
      setSettingsKeySet(d.key_set || false);
      setSettingsKeySource(d.key_source || "none");
    }).catch(() => {});
  }, [settingsOpen]);

  async function saveSettings() {
    try {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify(settingsDraft),
      });
      setSettingsSaved("saved");
      setTimeout(() => { setSettingsSaved(""); setSettingsOpen(false); }, 900);
    } catch (e) {
      setSettingsSaved(`error:${e.message}`);
    }
  }

  function handleOrgSelect(org) {
    setActiveOrg(org);
    setOrgContext({ objects: [], fields: {} });
    setApiLimits(null);
    setShowOrgPicker(false);
  }

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

      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 py-2 bg-blue-700 text-white shadow-md select-none">
        <span className="font-bold text-lg tracking-tight">⚡ Vendavis</span>
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
          <button
            onClick={() => { setSettingsSaved(""); setSettingsOpen(true); }}
            className="text-sm bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-3 py-1 transition-colors"
            title="AI Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      {/* Page content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === "fls"      && <FlsExplorer      org={activeOrg} ctx={orgContext} setCtx={setOrgContext} onApiCall={() => fetchLimits()} />}
        {activeTab === "profiles" && <ProfilesExplorer org={activeOrg} onApiCall={() => fetchLimits()} />}
        {activeTab === "soql"     && <SoqlRunner        org={activeOrg} ctx={orgContext} onSwitchClaude={() => setActiveTab("claude")} onApiCall={() => fetchLimits()} />}
        {activeTab === "apex"     && <ApexRunner        org={activeOrg} onApiCall={() => fetchLimits()} />}
        {activeTab === "claude"   && <ClaudeChat        org={activeOrg} ctx={orgContext} setCtx={setOrgContext} />}
      </main>

      {/* Global footer — API limit status bar */}
      {activeOrg && (
        <footer className="shrink-0 flex items-center justify-end gap-2 px-4 py-1 bg-gray-900 border-t border-gray-700 text-xs font-mono select-none">
          {limitsError ? (
            <span className="text-red-400" title={limitsError}>⚠ Limits unavailable</span>
          ) : apiLimits ? (
            <>
              <span className="text-gray-500">Org API calls</span>
              <span className={`font-semibold ${pctColor}`}>
                {apiLimits.used.toLocaleString()} / {apiLimits.max.toLocaleString()}
              </span>
              <span className="text-gray-600">({pct}%)</span>
            </>
          ) : (
            <span className="text-gray-600">Org API calls —</span>
          )}
          <button onClick={() => fetchLimits()} className="text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">↻</button>
          <button onClick={() => setLimitsOpen(true)} className="text-gray-500 hover:text-blue-400 transition-colors font-bold" title="About API limits">?</button>
        </footer>
      )}

      {/* ── Settings modal ───────────────────────────────────────────────────── */}
      {settingsOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setSettingsOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-800 dark:text-white">Claude / AI Settings</h2>
              <button onClick={() => setSettingsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">✕</button>
            </div>

            <div className="flex flex-col gap-4 text-sm">
              {/* API Key */}
              <label className="flex flex-col gap-1">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  API Key
                  {settingsKeySet && settingsKeySource === "vendavis" && (
                    <span className="ml-2 text-xs text-green-500 font-normal">✓ key saved</span>
                  )}
                  {settingsKeySet && settingsKeySource === "legacy" && (
                    <span className="ml-2 text-xs text-yellow-500 font-normal">✓ using key from SOQL Explorer config</span>
                  )}
                </span>
                <input
                  type="password"
                  placeholder={settingsKeySet ? "••••••••••••••••••••••••" : "sk-ant-…"}
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
                  <span className="ml-1 text-xs text-gray-400 font-normal">(leave blank for api.anthropic.com)</span>
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
                <span className="font-medium text-gray-700 dark:text-gray-300">Model</span>
                <select
                  value={settingsDraft.model}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, model: e.target.value }))}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Default (Claude Sonnet)</option>
                  {availModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
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
              <p><strong className="text-gray-800 dark:text-white">How Vendavis uses API calls:</strong></p>
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
                Vendavis caches FLS data in memory for 5 minutes to minimise repeat calls.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
