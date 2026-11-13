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
  : s >= 400           ? "text-red-600 dark:text-red-400"
  :                      "text-yellow-600 dark:text-yellow-400";

const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
  500: "Internal Server Error", 503: "Service Unavailable",
};

const DEFAULT_PATH = "/services/data/v68.0/";

// History stored in module scope so it persists across tab switches (not across sessions)
let _history = [];

// ── Sample requests ────────────────────────────────────────────────────────
const SAMPLES = [
  {
    group: "Getting Started",
    items: [
      { label: "API root",              method: "GET",  path: "/services/data/v68.0/" },
      { label: "List all objects",      method: "GET",  path: "/services/data/v68.0/sobjects" },
      { label: "Org limits",            method: "GET",  path: "/services/data/v68.0/limits" },
    ],
  },
  {
    group: "Query (SOQL)",
    items: [
      { label: "Recent Accounts",       method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,Name,Industry+FROM+Account+ORDER+BY+LastModifiedDate+DESC+LIMIT+10" },
      { label: "Open Opportunities",    method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,Name,StageName,Amount+FROM+Opportunity+WHERE+IsClosed=false+ORDER+BY+CloseDate+ASC+LIMIT+10" },
      { label: "Active Users",          method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,Name,Username,IsActive+FROM+User+WHERE+IsActive=true+ORDER+BY+Name+LIMIT+20" },
      { label: "Recent Cases",          method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,CaseNumber,Subject,Status+FROM+Case+ORDER+BY+CreatedDate+DESC+LIMIT+10" },
    ],
  },
  {
    group: "Metadata",
    items: [
      { label: "Describe Account",      method: "GET",  path: "/services/data/v68.0/sobjects/Account/describe" },
      { label: "Describe Contact",      method: "GET",  path: "/services/data/v68.0/sobjects/Contact/describe" },
      { label: "Describe Opportunity",  method: "GET",  path: "/services/data/v68.0/sobjects/Opportunity/describe" },
    ],
  },
  {
    group: "Tooling API",
    items: [
      { label: "List Apex Classes",     method: "GET",  path: "/services/data/v68.0/tooling/query?q=SELECT+Id,Name,Status+FROM+ApexClass+ORDER+BY+Name+LIMIT+20" },
      { label: "List Apex Triggers",    method: "GET",  path: "/services/data/v68.0/tooling/query?q=SELECT+Id,Name,TableEnumOrId,Status+FROM+ApexTrigger+ORDER+BY+Name+LIMIT+20" },
      { label: "Custom Objects",        method: "GET",  path: "/services/data/v68.0/tooling/query?q=SELECT+Id,DeveloperName,Label+FROM+CustomObject+ORDER+BY+DeveloperName+LIMIT+20" },
    ],
  },
  {
    group: "Org Health",
    items: [
      { label: "Password policies",     method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,PasswordComplexity,MinPasswordLength,PasswordExpiration,MaxLoginAttempts+FROM+SecuritySettings+LIMIT+1" },
      { label: "Setup audit trail",     method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,CreatedBy.Name,Action,Section,Display,CreatedDate+FROM+SetupAuditTrail+ORDER+BY+CreatedDate+DESC+LIMIT+20" },
      { label: "Login history (24h)",   method: "GET",  path: "/services/data/v68.0/query?q=SELECT+Id,UserId,LoginTime,LoginType,Status,SourceIp+FROM+LoginHistory+WHERE+LoginTime=LAST_N_HOURS:24+ORDER+BY+LoginTime+DESC+LIMIT+50" },
    ],
  },
];

// ── Help / Samples modal ───────────────────────────────────────────────────
function HelpModal({ onClose, onLoad }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900 overflow-hidden">

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-gray-800">
          <div>
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">REST Explorer — How to Use</p>
            <p className="text-xs text-slate-400 mt-0.5">Click any sample to load it into the editor</p>
          </div>
          <button onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-lg dark:hover:text-slate-200 leading-none transition-colors">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">

          {/* How to use */}
          <section className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-slate-700 dark:bg-blue-950/40 dark:border-blue-900 dark:text-slate-300 leading-relaxed space-y-1.5">
            <p><strong className="text-slate-800 dark:text-slate-100">1. Select a method</strong> — GET for reads, POST/PUT/PATCH to create or update, DELETE to remove.</p>
            <p><strong className="text-slate-800 dark:text-slate-100">2. Enter a path</strong> — always relative, e.g. <code className="bg-blue-100 dark:bg-blue-900/50 px-1 rounded font-mono">/services/data/v68.0/sobjects</code>. The org base URL is added automatically.</p>
            <p><strong className="text-slate-800 dark:text-slate-100">3. For POST/PUT/PATCH</strong> — a JSON body editor appears below the path. Paste or type your request body there.</p>
            <p><strong className="text-slate-800 dark:text-slate-100">4. Use Up</strong> — navigates to the parent path segment, handy for exploring nested resources.</p>
            <p><strong className="text-slate-800 dark:text-slate-100">5. Click links</strong> in the response tree to navigate directly to that resource.</p>
            <p><strong className="text-slate-800 dark:text-slate-100">6. Raw mode</strong> — shows the response as plain JSON text instead of the interactive tree.</p>
          </section>

          {/* Samples */}
          {SAMPLES.map(group => (
            <section key={group.group}>
              <p className="text-xs font-bold text-slate-500 uppercase dark:text-slate-400 tracking-wider mb-2">{group.group}</p>
              <div className="flex flex-col gap-1">
                {group.items.map(item => (
                  <button
                    key={item.path}
                    onClick={() => { onLoad(item); onClose(); }}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-100 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 dark:hover:border-gray-600 text-left transition-colors group"
                  >
                    <span className={`shrink-0 font-bold text-xs px-1.5 py-0.5 rounded ${METHOD_COLORS[item.method]}`}>
                      {item.method}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-slate-700 group-hover:text-slate-900 dark:text-slate-200 dark:group-hover:text-white">{item.label}</span>
                      <span className="block text-xs font-mono text-slate-400 truncate mt-0.5">{item.path}</span>
                    </span>
                    <span className="text-slate-300 group-hover:text-blue-400 text-sm">→</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 border-t border-slate-100 bg-slate-50 dark:border-gray-800 dark:bg-gray-800/60 flex justify-end">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-slate-100 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── JSON tree renderer ─────────────────────────────────────────────────────
function JsonNode({ data, depth = 0 }) {
  const [collapsed, setCollapsed] = useState(depth > 2);
  const indent = depth * 16;

  if (data === null)    return <span className="text-slate-400 italic">null</span>;
  if (data === true)    return <span className="text-emerald-600 dark:text-emerald-400">true</span>;
  if (data === false)   return <span className="text-red-500 dark:text-red-400">false</span>;
  if (typeof data === "number") return <span className="text-orange-600 dark:text-orange-400">{data}</span>;
  if (typeof data === "string") {
    // Linkify SF REST paths
    if (data.startsWith("/services/")) {
      return <span className="text-blue-600 underline cursor-pointer dark:text-blue-400" data-path={data}>{`"${data}"`}</span>;
    }
    return <span className="text-emerald-700 dark:text-emerald-300">{`"${data}"`}</span>;
  }

  const isArray  = Array.isArray(data);
  const entries  = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
  const open     = isArray ? "[" : "{";
  const close    = isArray ? "]" : "}";
  const count    = entries.length;

  if (count === 0) return <span className="text-slate-400">{open}{close}</span>;

  return (
    <span>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="text-slate-400 hover:text-slate-700 mr-1 font-mono dark:hover:text-slate-200"
      >
        {collapsed ? "▶" : "▼"}
      </button>
      <span className="text-slate-500 dark:text-slate-400">{open}</span>
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="text-slate-400 hover:text-slate-600 text-xs mx-1 italic dark:hover:text-slate-200"
        >
          {count} {isArray ? "items" : "keys"}
        </button>
      ) : (
        <div style={{ marginLeft: indent + 16 }}>
          {entries.map(([k, v], i) => (
            <div key={k} className="leading-6">
              {!isArray && (
                <span className="text-violet-700 mr-1">"{k}":</span>
              )}
              <JsonNode data={v} depth={depth + 1} />
              {i < count - 1 && <span className="text-slate-400">,</span>}
            </div>
          ))}
        </div>
      )}
      {!collapsed && <span className="text-slate-500 dark:text-slate-400" style={{ marginLeft: indent }}>{close}</span>}
    </span>
  );
}

export default function RestExplorer({ org }) {
  const [method,    setMethod]   = useState("GET");
  const [path,      setPath]     = useState(DEFAULT_PATH);
  const [body,      setBody]     = useState("");
  const [response,  setResponse] = useState(null);   // { status, headers, body }
  const [loading,   setLoading]  = useState(false);
  const [rawMode,   setRawMode]  = useState(false);
  const [history,   setHistory]  = useState(_history);
  const [histOpen,  setHistOpen] = useState(false);
  const [helpOpen,  setHelpOpen] = useState(false);
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
    executeWith(method, path, needsBody && body.trim() ? body.trim() : null);
  }

  function loadHistory(entry) {
    setMethod(entry.method);
    setPath(entry.path);
    setHistOpen(false);
  }

  function loadSample(item) {
    setMethod(item.method);
    setPath(item.path);
    setBody("");
    setRawMode(false);
    // Auto-execute after a tick so state has settled
    setTimeout(() => executeWith(item.method, item.path, null), 0);
  }

  async function executeWith(m, p, b) {
    if (!org) return;
    setLoading(true);
    setResponse(null);
    try {
      const result = await api(`/api/orgs/${org.alias}/rest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: m, path: p, body: b }),
      });
      setResponse(result);
      const entry = { method: m, path: p, ts: Date.now() };
      _history = [entry, ..._history.filter(h => h.path !== p || h.method !== m)].slice(0, 50);
      setHistory(_history);
    } catch (e) {
      setResponse({ status: 0, headers: {}, body: { error: e.message } });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {helpOpen && (
        <HelpModal onClose={() => setHelpOpen(false)} onLoad={loadSample} />
      )}
    <div className="flex flex-col h-full overflow-hidden bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-200 px-4 py-3 flex flex-col gap-2 dark:border-gray-700">

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
            className="flex-1 font-mono text-sm px-3 py-1.5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          {/* Help */}
          <button
            onClick={() => setHelpOpen(true)}
            title="How to use & sample requests"
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors shrink-0 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-100"
          >
            ?
          </button>

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
            className="font-mono text-xs px-3 py-2 rounded-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
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
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-3">
                <span className={`font-bold text-sm ${STATUS_COLOR(response.status)}`}>
                  {response.status
                    ? `HTTP ${response.status}${STATUS_TEXT[response.status] ? ` — ${STATUS_TEXT[response.status]}` : ""}`
                    : "Error"}
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
                  className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 transition-colors dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Copy
                </button>
                <button
                  onClick={() => setRawMode(r => !r)}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                    rawMode
                      ? "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800"
                      : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  }`}
                >
                  Raw
                </button>
              </div>
            </div>

            {/* Response body */}
            <div
              className="flex-1 overflow-auto p-4 font-mono text-xs bg-slate-50 text-slate-800 dark:bg-gray-950 dark:text-gray-100"
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
    </>
  );
}
