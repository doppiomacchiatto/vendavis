import { useEffect, useState } from "react";
import { api } from "../api/client";
import Spinner from "./Spinner";

export default function OrgPickerModal({ onSelect }) {
  const [orgs,    setOrgs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [chosen,  setChosen]  = useState("");
  const [log,     setLog]     = useState([]);

  function addLog(msg) {
    setLog((l) => [...l, `${new Date().toISOString().slice(11,23)} ${msg}`]);
  }

  useEffect(() => {
    async function init() {
      // 1. Health check first
      addLog("Checking backend health…");
      try {
        await api("/api/health");
        addLog("✅ Backend is running");
      } catch (e) {
        const msg =
          "Cannot reach the backend server.\n" +
          "Start it with: npm run dev:backend";
        addLog("❌ " + msg);
        setError(msg);
        setLoading(false);
        return;
      }

      // 2. Load orgs
      addLog("Fetching orgs…");
      try {
        const d = await api("/api/orgs");
        const list = d.orgs || [];
        addLog(`✅ Found ${list.length} org(s)`);
        setOrgs(list);
        const def = list.find((o) => o.isDefault);
        if (def) setChosen(def.alias);
      } catch (e) {
        addLog(`❌ ${String(e)}`);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  function confirm() {
    const org = orgs.find((o) => o.alias === chosen);
    if (org) onSelect(org);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[420px] p-8 flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <span className="text-2xl">⚡</span>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Vendavis</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Select a Salesforce org to get started</p>
        </div>

        {/* Org list */}
        {loading ? (
          <div className="flex justify-center py-4"><Spinner label="Loading orgs…" /></div>
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

        {/* Debug log */}
        {log.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-2 max-h-28 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className="font-mono text-xs text-green-400 whitespace-pre-wrap">{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
