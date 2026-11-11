import { useState, useRef } from "react";
import { api } from "../api/client";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const METHOD_COLORS = {
  GET:    "bg-blue-100   text-blue-700   dark:bg-blue-900/40   dark:text-blue-300",
  POST:   "bg-green-100  text-green-700  dark:bg-green-900/40  dark:text-green-300",
  PUT:    "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  PATCH:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  DELETE: "bg-red-100    text-red-700    dark:bg-red-900/40    dark:text-red-300",
};

const STATUS_COLOR = (s) =>
  s >= 200 && s < 300 ? "text-green-600 dark:text-green-400"
  : s >= 400           ? "text-red-600   dark:text-red-400"
  :                      "text-yellow-600 dark:text-yellow-400";

const DEFAULT_PATH = "/services/data/v68.0/";

// History stored in module scope so it persists across tab switches (not across sessions)
let _history = [];

// ── JSON tree renderer ─────────────────────────────────────────────────────
function JsonNode({ data, depth = 0 }) {
  const [collapsed, setCollapsed] = useState(depth > 2);
  const indent = depth * 16;

  if (data === null)    return <span className="text-gray-400">null</span>;
  if (data === true)    return <span className="text-green-500">true</span>;
  if (data === false)   return <span className="text-red-400">false</span>;
  if (typeof data === "number") return <span className="text-orange-400">{data}</span>;
  if (typeof data === "string") {
    // Linkify SF REST paths
    if (data.startsWith("/services/")) {
      return <span className="text-blue-400 underline cursor-pointer" data-path={data}>{`"${data}"`}</span>;
    }
    return <span className="text-emerald-400">{`"${data}"`}</span>;
  }

  const isArray  = Array.isArray(data);
  const entries  = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
  const open     = isArray ? "[" : "{";
  const close    = isArray ? "]" : "}";
  const count    = entries.length;

  if (count === 0) return <span className="text-gray-500">{open}{close}</span>;

  return (
    <span>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="text-gray-400 hover:text-white mr-1 font-mono"
      >
        {collapsed ? "▶" : "▼"}
      </button>
      <span className="text-gray-400">{open}</span>
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="text-gray-500 hover:text-gray-300 text-xs mx-1 italic"
        >
          {count} {isArray ? "items" : "keys"}
        </button>
      ) : (
        <div style={{ marginLeft: indent + 16 }}>
          {entries.map(([k, v], i) => (
            <div key={k} className="leading-6">
              {!isArray && (
                <span className="text-purple-300 mr-1">"{k}":</span>
              )}
              <JsonNode data={v} depth={depth + 1} />
              {i < count - 1 && <span className="text-gray-600">,</span>}
            </div>
          ))}
        </div>
      )}
      {!collapsed && <span className="text-gray-400" style={{ marginLeft: indent }}>{close}</span>}
    </span>
  );
}

export default function RestExplorer({ org }) {
  const [method,   setMethod]   = useState("GET");
  const [path,     setPath]     = useState(DEFAULT_PATH);
  const [body,     setBody]     = useState("");
  const [response, setResponse] = useState(null);   // { status, headers, body }
  const [loading,  setLoading]  = useState(false);
  const [rawMode,  setRawMode]  = useState(false);
  const [history,  setHistory]  = useState(_history);
  const [histOpen, setHistOpen] = useState(false);
  const pathRef = useRef(null);

  const needsBody = ["POST", "PUT", "PATCH"].includes(method);

  // Navigate up one path segment
  function goUp() {
    const p = path.replace(/\/$/, "");
    const parts = p.split("/");
    if (parts.length > 1) {
      setPath(parts.slice(0, -1).join("/") + "/");
    }
  }

  // Click a path link inside the response tree
  function handleResponseClick(e) {
    const pathVal = e.target.dataset?.path;
    if (pathVal) { setPath(pathVal); setMethod("GET"); }
  }

  async function execute() {
    if (!org) return;
    setLoading(true);
    setResponse(null);
    try {
      const result = await api(`/api/orgs/${org.alias}/rest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method,
          path,
          body: needsBody && body.trim() ? body.trim() : null,
        }),
      });
      setResponse(result);
      // Add to history
      const entry = { method, path, ts: Date.now() };
      _history = [entry, ..._history.filter(h => h.path !== path || h.method !== method)].slice(0, 50);
      setHistory(_history);
    } catch (e) {
      setResponse({ status: 0, headers: {}, body: { error: e.message } });
    } finally {
      setLoading(false);
    }
  }

  function loadHistory(entry) {
    setMethod(entry.method);
    setPath(entry.path);
    setHistOpen(false);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex flex-col gap-2">

        {/* Method + URL row */}
        <div className="flex gap-2 items-center">
          {/* Method selector */}
          <div className="flex gap-1 shrink-0">
            {METHODS.map(m => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`px-2.5 py-1 rounded text-xs font-bold transition-colors ${
                  method === m
                    ? METHOD_COLORS[m]
                    : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Path input */}
          <input
            ref={pathRef}
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") execute(); }}
            spellCheck={false}
            className="flex-1 font-mono text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="/services/data/v68.0/"
          />

          {/* Up button */}
          <button
            onClick={goUp}
            title="Navigate up one level"
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors font-medium"
          >
            Up
          </button>

          {/* History button */}
          <div className="relative">
            <button
              onClick={() => setHistOpen(o => !o)}
              title="Request history"
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              🕐
            </button>
            {histOpen && history.length > 0 && (
              <div className="absolute right-0 top-full mt-1 w-[480px] bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
                <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  Recent requests
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {history.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => loadHistory(h)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      <span className={`shrink-0 font-bold px-1.5 py-0.5 rounded ${METHOD_COLORS[h.method]}`}>{h.method}</span>
                      <span className="font-mono truncate text-gray-700 dark:text-gray-300">{h.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Execute */}
          <button
            onClick={execute}
            disabled={loading || !org}
            className="px-4 py-1.5 bg-[#1a2d5a] hover:bg-[#233d7a] disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            {loading ? "…" : "Execute"}
          </button>
        </div>

        {/* Body textarea — only for POST/PUT/PATCH */}
        {needsBody && (
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder='{ "Name": "Test Account" }'
            className="font-mono text-xs px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
        )}

        {/* No org warning */}
        {!org && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Select an org to use the REST Explorer.</p>
        )}
      </div>

      {/* ── Response area ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!response && !loading && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-600 select-none">
            Enter a path and click Execute
          </div>
        )}

        {loading && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400 animate-pulse">
            Executing…
          </div>
        )}

        {response && (
          <>
            {/* Response status bar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex items-center gap-3">
                <span className={`font-bold text-sm ${STATUS_COLOR(response.status)}`}>
                  {response.status || "Error"}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {response.headers?.["content-type"] || ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const text = typeof response.body === "string"
                      ? response.body
                      : JSON.stringify(response.body, null, 2);
                    navigator.clipboard?.writeText(text);
                  }}
                  className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={() => setRawMode(r => !r)}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                    rawMode
                      ? "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800"
                      : "border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  Raw
                </button>
              </div>
            </div>

            {/* Response body */}
            <div
              className="flex-1 overflow-auto p-4 font-mono text-xs bg-gray-950 dark:bg-gray-950 text-gray-100"
              onClick={handleResponseClick}
            >
              {rawMode || typeof response.body === "string" ? (
                <pre className="whitespace-pre-wrap break-all">
                  {typeof response.body === "string"
                    ? response.body
                    : JSON.stringify(response.body, null, 2)}
                </pre>
              ) : (
                <JsonNode data={response.body} depth={0} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
