/**
 * SOQL Runner — SoqlX-inspired layout
 * Left: collapsible SObject browser with search + field drill-in
 * Center: SOQL editor + results table + collapsible debug log
 * Right: Claude AI split panel (toggleable)
 */
import { useState, useEffect, useRef } from "react";
import { api, apiStream } from "../api/client";
import Spinner from "../components/Spinner";
import DebugLogPanel from "../components/DebugLogPanel";

const PAGE_SIZE = 50;

// ─── AI Panel (same pattern as ApexRunner) ────────────────────────────────────

const QUICK_CHIPS = [
  { label: "✍️ Write Query",    prompt: "Write a SOQL query for me based on the objects loaded in the browser." },
  { label: "✨ Explain",        prompt: "Explain what this SOQL query does." },
  { label: "⚡ Optimize",       prompt: "Optimize this SOQL query for performance and governor limits." },
  { label: "🔧 Fix Error",      prompt: "There is an error in this SOQL query. Identify and fix it." },
];

function AiPanel({ query, results, onInsert, onClose }) {
  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamBuf, setStreamBuf] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamBuf]);

  function buildSystem() {
    let sys = `You are an expert Salesforce SOQL developer embedded in Vendavis.
Help the user write, debug, and optimize SOQL queries.
When providing a query, wrap it in a \`\`\`soql code block.
Be concise and direct.`;
    if (query.trim()) {
      sys += `\n\nCurrent editor query:\n\`\`\`soql\n${query}\n\`\`\``;
    }
    if (results.cols.length) {
      sys += `\n\nLast query returned ${results.rows.length} rows with columns: ${results.cols.join(", ")}.`;
      if (results.rows.length) {
        const preview = results.rows.slice(0, 3).map(r =>
          Object.fromEntries(results.cols.map((c, i) => [c, r[i]]))
        );
        sys += `\nSample rows: ${JSON.stringify(preview)}`;
      }
    }
    return sys;
  }

  async function sendMessage(userText) {
    if (!userText.trim() || streaming) return;
    const userMsg = { role: "user", content: userText.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);
    setStreamBuf("");
    let fullText = "";

    await apiStream(
      "/api/claude/chat",
      { messages: newMessages, system: buildSystem() },
      (delta) => { fullText += delta; setStreamBuf(fullText); },
      () => { setMessages(prev => [...prev, { role: "assistant", content: fullText }]); setStreaming(false); setStreamBuf(""); },
      (err) => {
        const isNoKey = err.includes("No Anthropic API key");
        setMessages(prev => [...prev, { role: "assistant", content: isNoKey
          ? "🔑 No API key configured. Click **⚙ Settings** in the top bar."
          : `⚠ Error: ${err}` }]);
        setStreaming(false); setStreamBuf("");
      },
    );
  }

  function parseBlocks(text) {
    const parts = [];
    const re = /```(?:soql|sql|apex|javascript)?\n?([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ type: "text", content: text.slice(last, m.index) });
      parts.push({ type: "code", content: m[1].trimEnd() });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: "text", content: text.slice(last) });
    return parts;
  }

  function AssistantMessage({ content }) {
    return (
      <div className="flex flex-col gap-2">
        {parseBlocks(content).map((b, i) => b.type === "text" ? (
          <p key={i} className="text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">{b.content}</p>
        ) : (
          <div key={i} className="relative group">
            <pre className="text-xs font-mono bg-gray-950 border border-gray-700 rounded p-3 overflow-x-auto text-green-300 leading-5">{b.content}</pre>
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => onInsert(b.content)} className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">→ Use Query</button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 border-l border-slate-700">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700">
        <span className="text-sm font-semibold text-white">✨ Claude AI</span>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setStreamBuf(""); }} className="text-xs text-slate-300 hover:text-red-400">🗑 Clear</button>
          )}
          <button onClick={onClose} className="text-slate-300 hover:text-white text-sm">✕</button>
        </div>
      </div>

      {/* Quick chips */}
      <div className="shrink-0 flex flex-wrap gap-1.5 px-3 py-2 border-b border-slate-700">
        {QUICK_CHIPS.map((c) => (
          <button key={c.label} disabled={streaming} onClick={() => sendMessage(c.prompt)}
            className="px-2.5 py-1 text-xs bg-slate-700 hover:bg-blue-700 disabled:opacity-40 text-white rounded-full border border-blue-600 transition-colors font-medium">
            {c.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4 min-h-0">
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-slate-300 text-center pt-6 leading-relaxed px-2">
            Ask Claude to write or explain a SOQL query.<br/>
            <span className="text-slate-400">Your current query and results are sent as context.</span>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {msg.role === "user"
              ? <div className="max-w-[90%] bg-blue-600 text-white text-xs px-3 py-2 rounded-2xl rounded-tr-sm">{msg.content}</div>
              : <div className="w-full"><AssistantMessage content={msg.content} /></div>
            }
          </div>
        ))}
        {streaming && streamBuf && <div className="w-full"><AssistantMessage content={streamBuf} /></div>}
        {streaming && !streamBuf && (
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Spinner label="" /><span>Claude is thinking…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2 border-t border-slate-700">
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 min-h-[36px] max-h-32 text-xs border border-slate-600 rounded-lg px-3 py-2 bg-slate-800 text-slate-50 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none leading-5"
            placeholder="Ask Claude about your SOQL query…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
            rows={1}
          />
          <button onClick={() => sendMessage(input)} disabled={streaming || !input.trim()}
            className="shrink-0 px-3 py-2 bg-blue-500 hover:bg-blue-400 disabled:opacity-40 text-white rounded-lg text-xs font-semibold">↑</button>
        </div>
        <p className="text-xs text-slate-400 mt-1">↵ send · Shift+↵ newline</p>
      </div>
    </div>
  );
}

// ─── Main SoqlRunner ──────────────────────────────────────────────────────────

export default function SoqlRunner({ org, ctx, setCtx, loadObjects, onApiCall }) {
  const [query,       setQuery]      = useState("SELECT Id, Name FROM Account LIMIT 10");
  const [rows,        setRows]       = useState([]);
  const [cols,        setCols]       = useState([]);
  const [page,        setPage]       = useState(0);
  const [loading,     setLoading]    = useState(false);
  const [error,       setError]      = useState("");
  const [history,     setHistory]    = useState([]);
  const [historyOpen, setHistoryOpen]= useState(true);
  const [debugLog,    setDebugLog]   = useState([]);
  const [debugOpen,   setDebugOpen]  = useState(false);
  const [aiOpen,      setAiOpen]     = useState(false);

  // SObject browser — reads from shared ctx
  const objects    = ctx?.objects || [];
  const objLoaded  = ctx?.objectsLoaded || false;
  const objLoading = ctx?.objectsLoading || false;
  const [objFilter,    setObjFilter]   = useState("");
  const [expandedObj,  setExpandedObj] = useState(null);
  const [fieldMap,     setFieldMap]    = useState({});
  const [fieldLoading, setFieldLoading]= useState(null);
  const [sidebarOpen,  setSidebarOpen] = useState(true);

  function log(msg, type = "info") {
    const ts = new Date().toISOString().slice(11, 23);
    const icon = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
    setDebugLog(l => [...l, { ts, icon, msg }]);
    if (type === "error") setDebugOpen(true);
  }

  // Load history on mount
  useEffect(() => {
    api("/api/soql/history?limit=50")
      .then((d) => setHistory(d.history || []))
      .catch(() => {});
  }, []);

  function handleLoadObjects() {
    log(`Loading objects from ${org?.alias}…`);
    loadObjects?.();
  }

  async function toggleExpand(obj) {
    if (expandedObj === obj.apiName) { setExpandedObj(null); return; }
    setExpandedObj(obj.apiName);
    if (fieldMap[obj.apiName]) return; // already loaded
    setFieldLoading(obj.apiName);
    try {
      const d = await api(`/api/orgs/${org.alias}/objects/${obj.apiName}/fields`);
      setFieldMap(m => ({ ...m, [obj.apiName]: d.fields || [] }));
    } catch (e) {
      log(`Failed to load fields for ${obj.apiName}: ${e.message}`, "error");
    } finally {
      setFieldLoading(null);
    }
  }

  function insertFieldInQuery(objApi, fieldApi) {
    // If query already has SELECT ... FROM ObjApi, insert the field
    const selectMatch = query.match(/SELECT\s+(.*?)\s+FROM/is);
    if (selectMatch) {
      const newQuery = query.replace(selectMatch[1], selectMatch[1] + `, ${fieldApi}`);
      setQuery(newQuery);
    } else {
      setQuery(`SELECT ${fieldApi} FROM ${objApi} LIMIT 10`);
    }
  }

  function useObject(obj) {
    setQuery(`SELECT Id, Name FROM ${obj.apiName} LIMIT 10`);
  }

  async function runQuery() {
    if (!org) { setError("Select an org first."); return; }
    setLoading(true); setError(""); setRows([]); setCols([]); setPage(0);
    log(`Running: ${query.slice(0, 80)}${query.length > 80 ? "…" : ""}`);
    const t0 = Date.now();
    try {
      const d = await api("/api/soql", {
        method: "POST",
        body: JSON.stringify({ alias: org.alias, query }),
      });
      const records = d.records || [];
      const columns = records.length ? Object.keys(records[0]).filter((k) => k !== "attributes") : [];
      setCols(columns);
      setRows(records.map((r) => columns.map((c) => String(r[c] ?? ""))));
      setHistory((h) => [query, ...h.filter((q) => q !== query)].slice(0, 50));
      log(`${records.length} rows returned in ${Date.now() - t0}ms`, "success");
      onApiCall?.();
    } catch (e) {
      setError(e.message);
      log(e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!cols.length) return;
    const lines = [cols.join(","), ...rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "soql_results.csv"; a.click();
    URL.revokeObjectURL(url);
    log(`Exported ${rows.length} rows as CSV`, "success");
  }

  const filteredObjs = objects.filter(o =>
    o.label.toLowerCase().includes(objFilter.toLowerCase()) ||
    o.apiName.toLowerCase().includes(objFilter.toLowerCase())
  );
  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left: SObject browser ──────────────────────────────────────────── */}
      {sidebarOpen && (
        <aside className="w-64 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shrink-0">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">SObjects</span>
            <button onClick={() => setSidebarOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs" title="Collapse sidebar">◀</button>
          </div>
          {/* Search */}
          <div className="px-2 py-2 border-b border-gray-200 dark:border-gray-700">
            <input
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-400"
              placeholder="🔍 Search…"
              value={objFilter}
              onChange={(e) => setObjFilter(e.target.value)}
            />
          </div>
          {/* Load button or list */}
          {!objLoaded ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 p-4">
              <p className="text-xs text-gray-400 text-center">Load SObjects to browse and click-to-query</p>
              <button
                onClick={handleLoadObjects}
                disabled={objLoading || !org}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg font-medium transition-colors"
              >
                {objLoading ? <Spinner label="Loading…" /> : "⬇ Load Objects"}
              </button>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto text-sm">
              {filteredObjs.map((obj) => (
                <div key={obj.apiName}>
                  {/* Object row */}
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer group">
                    <button
                      onClick={() => toggleExpand(obj)}
                      className="shrink-0 w-4 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xs"
                    >
                      {expandedObj === obj.apiName ? "▼" : "▶"}
                    </button>
                    <span
                      onClick={() => useObject(obj)}
                      className="flex-1 truncate font-medium text-gray-800 dark:text-gray-200 text-xs"
                      title={obj.apiName}
                    >
                      {obj.label}
                    </span>
                    <span className="text-xs text-gray-400 truncate hidden group-hover:block max-w-[80px]">{obj.apiName}</span>
                  </div>
                  {/* Expanded fields */}
                  {expandedObj === obj.apiName && (
                    <div className="bg-gray-50 dark:bg-gray-900/30 border-b border-gray-200 dark:border-gray-700">
                      {fieldLoading === obj.apiName ? (
                        <div className="px-6 py-2 text-xs text-gray-400"><Spinner label="Loading fields…" /></div>
                      ) : (fieldMap[obj.apiName] || []).map((f) => (
                        <div
                          key={f.apiName}
                          onClick={() => insertFieldInQuery(obj.apiName, f.apiName)}
                          className="flex items-center gap-2 px-6 py-1 cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-800/20 group/field"
                          title={`${f.type} — click to add to query`}
                        >
                          <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1">{f.apiName}</span>
                          <span className="text-xs text-gray-400 shrink-0">{f.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      {/* Collapsed sidebar toggle */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="shrink-0 w-6 flex items-center justify-center border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-700 transition-colors"
          title="Expand SObject browser"
        >
          <span className="text-xs rotate-180 writing-mode-vertical">▶</span>
        </button>
      )}

      {/* ── Center: editor + results + debug log ───────────────────────────── */}
      <div className={`flex flex-col overflow-hidden transition-all duration-200 ${aiOpen ? "flex-1" : "flex-1"}`}>

        {/* SOQL Editor */}
        <div className="shrink-0 flex gap-2 p-3 border-b border-gray-200 dark:border-gray-700">
          <textarea
            className="flex-1 font-mono text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={4}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runQuery(); } }}
            placeholder="Enter SOQL query…"
            spellCheck={false}
          />
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={runQuery}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-sm font-semibold transition-colors"
            >
              {loading ? <Spinner label="" /> : "▶ Run"}
            </button>
            <button
              onClick={() => setAiOpen(o => !o)}
              className={`px-3 py-2 rounded text-sm font-semibold border transition-colors ${
                aiOpen
                  ? "bg-violet-700 hover:bg-violet-800 text-white border-violet-600"
                  : "bg-gray-100 dark:bg-gray-700 hover:bg-violet-50 dark:hover:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-700"
              }`}
              title="Toggle Claude AI"
            >
              ✨ AI
            </button>
            {cols.length > 0 && (
              <button
                onClick={exportCsv}
                className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-semibold transition-colors"
                title="Export results to CSV"
              >
                📥 CSV
              </button>
            )}
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="shrink-0 px-3 py-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 font-mono">
            ✗ {error}
          </div>
        )}

        {/* Results summary bar */}
        {cols.length > 0 && (
          <div className="shrink-0 px-3 py-1 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 flex items-center justify-between">
            <span>{rows.length.toLocaleString()} rows · {cols.length} columns</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <span>Page {page + 1} of {totalPages}</span>
                <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-2 py-0.5 border rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700">◀</button>
                <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} className="px-2 py-0.5 border rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700">▶</button>
              </div>
            )}
          </div>
        )}

        {/* Results table */}
        <div className="flex-1 overflow-auto min-h-0">
          {cols.length === 0 && !loading && !error && (
            <div className="flex items-center justify-center h-full text-xs text-gray-400">
              {org ? "Run a query to see results" : "Select an org to get started"}
            </div>
          )}
          {cols.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase text-gray-500 tracking-wider">
                <tr>{cols.map((c) => <th key={c} className="px-3 py-2 whitespace-nowrap font-semibold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-750 hover:bg-blue-50 dark:hover:bg-slate-800/10"}>
                    {row.map((cell, j) => (
                      <td key={j} className="px-3 py-1.5 truncate max-w-xs text-gray-800 dark:text-gray-200 border-b border-gray-100 dark:border-gray-700/50" title={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Query history — collapsible */}
        {history.length > 0 && (
          <div className={`shrink-0 border-t border-gray-200 dark:border-gray-700 flex flex-col ${historyOpen ? "max-h-44" : "h-auto"}`}>
            <button
              onClick={() => setHistoryOpen(o => !o)}
              className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs font-semibold text-gray-500 uppercase tracking-wider w-full text-left transition-colors"
            >
              <span>🕐 Recent Queries ({history.length})</span>
              <span className="text-gray-400 normal-case font-normal">{historyOpen ? "▼ collapse" : "▲ expand"}</span>
            </button>
            {historyOpen && (
              <div className="overflow-y-auto">
                {history.slice(0, 20).map((q, i) => (
                  <div key={i} onClick={() => setQuery(q)}
                    className="px-3 py-1.5 text-xs font-mono truncate cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-800/20 border-b border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                    title={q}>{q}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Debug log (collapsible) */}
        <DebugLogPanel
          entries={debugLog}
          open={debugOpen}
          onToggle={() => setDebugOpen((o) => !o)}
          onClear={() => setDebugLog([])}
          heightClass="h-36"
          className="shrink-0"
        />
      </div>

      {/* ── Right: Claude AI panel ──────────────────────────────────────────── */}
      {aiOpen && (
        <div className="w-80 flex flex-col overflow-hidden border-l border-gray-300 dark:border-gray-700 shrink-0">
          <AiPanel
            query={query}
            results={{ cols, rows }}
            onInsert={(q) => setQuery(q)}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
