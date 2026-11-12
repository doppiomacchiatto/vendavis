import { useEffect, useState } from "react";
import { api } from "../api/client";
import Spinner from "./Spinner";
import { debugLog } from "../debugLog";

export default function OrgPickerModal({ onSelect }) {
  const [orgs,          setOrgs]          = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState("");
  const [chosen,        setChosen]        = useState("");
  const [startupStatus, setStartupStatus] = useState("starting"); // "starting" | "ready" | null
  const [slowStart,     setSlowStart]     = useState(false);

  function addLog(msg, level = "info") {
    debugLog(`[OrgPicker] ${msg}`, level);
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      // 1. Wait for the backend. The bundled backend takes ~6s to start when warm
      // and noticeably longer on first launch after an install (one-file unpack +
      // antivirus scan). No error is shown while it is starting: keep polling
      // until it answers, and only show a soft "taking longer" hint after 60s.
      addLog("Starting data services…", "start");
      setStartupStatus("starting");
      const DELAY_MS = 500;
      const SLOW_AFTER = 120; // attempts (~60s)
      for (let i = 0; !cancelled; i++) {
        try {
          await api("/api/health");
          break;
        } catch {
          if (i === 0) addLog("Waiting for data services to start…", "info");
          if (i === SLOW_AFTER) {
            addLog("Data services are taking longer than usual to start…", "warn");
            setSlowStart(true);
          }
          await new Promise(r => setTimeout(r, DELAY_MS));
        }
      }
      if (cancelled) return;
      setSlowStart(false);
      addLog("✅ Data services ready", "done");
      setStartupStatus("ready");
      // Brief pause so user sees "ready" before it disappears
      await new Promise(r => setTimeout(r, 600));
      setStartupStatus(null);

      // 2. Check SF CLI is available
      addLog("Checking Salesforce CLI…", "start");
      try {
        const sfInfo = await api("/api/sf-version");
        addLog(`✅ Salesforce CLI found (${sfInfo.version || sfInfo.sf_bin})`, "done");
      } catch (e) {
        const msg = String(e);
        // Backend returns HTTP 503 "Could not find 'sf' or 'sfdx'" when the binary is missing.
        // Timeouts (504) and other errors must not be reported as a missing CLI.
        if (msg.includes("Could not find")) {
          addLog("❌ Salesforce CLI not found", "error");
          setError("__sf_missing__");
          setLoading(false);
          return;
        }
        // Non-CLI error (network, timeout, etc.) — log and continue
        addLog(`⚠️ SF CLI check skipped: ${msg}`, "warn");
      }

      // 3. Load orgs
      addLog("Fetching orgs…", "start");
      try {
        const d = await api("/api/orgs");
        const list = d.orgs || [];
        addLog(`✅ Found ${list.length} org(s)`, "done");
        setOrgs(list);
        const def = list.find((o) => o.isDefault);
        if (def) setChosen(def.alias);
      } catch (e) {
        addLog(`❌ ${String(e)}`, "error");
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    init();
    return () => { cancelled = true; };
  }, []);

  function confirm() {
    const org = orgs.find((o) => o.alias === chosen);
    if (org) onSelect(org);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[420px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-[#1a2d5a] px-6 py-4 flex items-center gap-3">
          <img src="/icon-32.png" alt="Avio" className="w-7 h-7 object-contain shrink-0" />
          <div>
            <h1 className="text-base font-bold text-white leading-tight">Avio</h1>
            <p className="text-xs text-blue-200">Select a Salesforce org to get started</p>
          </div>
        </div>
        <div className="p-6 flex flex-col gap-5">

        {/* Startup status banner */}
        {startupStatus === "starting" && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Starting data services…</p>
              <p className="text-xs text-blue-500 dark:text-blue-400 mt-0.5">
                {slowStart
                  ? "Taking longer than usual. Still waiting, no action needed."
                  : "This takes a moment on first launch"}
              </p>
            </div>
          </div>
        )}
        {startupStatus === "ready" && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800">
            <span className="text-green-500 text-lg shrink-0">✓</span>
            <p className="text-sm font-medium text-green-700 dark:text-green-300">Data services ready</p>
          </div>
        )}

        {/* Org list */}
        {loading ? (
          <div className="flex justify-center py-4"><Spinner label="Loading orgs…" /></div>
        ) : error === "__sf_missing__" ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-3 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <span className="text-xl shrink-0">⚠️</span>
              <div>
                <p className="text-sm font-semibold text-red-700 dark:text-red-400">Salesforce CLI not found</p>
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 leading-relaxed">
                  The <code className="font-mono bg-red-100 dark:bg-red-900/40 px-1 rounded">sf</code> CLI is required and must be installed on your PATH before launching Avio.
                </p>
                <p className="text-xs text-red-500 dark:text-red-500 mt-2">
                  See <strong>Help → Pre-Requisites</strong> for install instructions.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Quick fix:</p>
              <code className="text-xs bg-gray-900 text-green-400 px-3 py-2 rounded font-mono">npm install -g @salesforce/cli</code>
            </div>
          </div>
        ) : error ? (
          <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3 whitespace-pre-wrap">
            {error}
          </div>
        ) : orgs.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-4">
            No orgs found. Run <code className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">sf org login web</code> first.
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {orgs.map((o) => (
              <button
                key={o.alias}
                onClick={() => setChosen(o.alias)}
                className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 text-left transition-colors ${
                  chosen === o.alias
                    ? "border-blue-600 bg-blue-50 dark:bg-blue-900/30"
                    : "border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500"
                }`}
              >
                <div>
                  <div className="font-medium text-sm text-gray-900 dark:text-white">{o.alias}</div>
                  <div className="text-xs text-gray-400 truncate max-w-xs">{o.username}</div>
                </div>
                <div className="flex items-center gap-2">
                  {o.isDefault && (
                    <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-medium">Default</span>
                  )}
                  {chosen === o.alias && <span className="text-blue-600 text-lg">✓</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Confirm */}
        <button
          disabled={!chosen || loading}
          onClick={confirm}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl font-semibold text-sm transition-colors"
        >
          Connect to org
        </button>

        </div>{/* end inner p-6 */}
      </div>
    </div>
  );
}
