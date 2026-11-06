/**
 * SOQL Runner page — editor, history sidebar, results table with pagination.
 */
import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import Spinner from "../components/Spinner";
import LoadingOverlay from "../components/LoadingOverlay";

const PAGE_SIZE = 50;

export default function SoqlRunner({ org, ctx, onSwitchClaude }) {
  const [query,    setQuery]    = useState("SELECT Id, Name FROM Account LIMIT 10");
  const [rows,     setRows]     = useState([]);
  const [cols,     setCols]     = useState([]);
  const [page,     setPage]     = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [history,  setHistory]  = useState([]);

  // Load history on mount
  useEffect(() => {
    api("/api/soql/history?limit=50")
      .then((d) => setHistory(d.history || []))
      .catch(() => {});
  }, []);

  async function runQuery() {
    if (!org) { setError("Select an org first."); return; }
    setLoading(true); setError(""); setRows([]); setCols([]); setPage(0);
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
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);

  function askClaude(mode) {
    onSwitchClaude(mode === "write" ? null : { cols, rows: rows.slice(0, 50), query });
  }

  return (
    <div className="flex h-full">
      {loading && <LoadingOverlay message="Running SOQL query…" />}
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Editor */}
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex gap-2">
          <textarea
            className="flex-1 font-mono text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={4}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runQuery(); } }}
            placeholder="Enter SOQL query…"
          />
          <button
            onClick={runQuery}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-sm font-medium self-start transition-colors"
          >
            {loading ? <Spinner label="" /> : "▶ Run"}
          </button>
        </div>
        {error && <div className="px-3 py-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20">{error}</div>}

        {/* Results */}
        <div className="flex-1 overflow-auto">
          {cols.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-left text-xs uppercase text-gray-500">
                <tr>{cols.map((c) => <th key={c} className="px-3 py-2 whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-white dark:bg-gray-800" : "bg-gray-50 dark:bg-gray-750"}>
                    {row.map((cell, j) => <td key={j} className="px-3 py-1.5 truncate max-w-xs">{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-500">
            <span>{rows.length} rows · page {page + 1} of {totalPages}</span>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700">◀ Prev</button>
              <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700">Next ▶</button>
            </div>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="w-60 flex flex-col border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {/* History */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700">History</div>
          {history.map((q, i) => (
            <div
              key={i}
              onClick={() => setQuery(q)}
              className="px-3 py-2 text-xs font-mono truncate cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700"
              title={q}
            >
              {q}
            </div>
          ))}
        </div>
        {/* Claude actions */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Claude Actions</div>
          <button onClick={() => askClaude("write")} className="w-full text-left px-3 py-2 text-sm rounded bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-medium transition-colors">✍️ Write Query</button>
          <button onClick={() => askClaude("explain")} disabled={rows.length === 0} className="w-full text-left px-3 py-2 text-sm rounded bg-purple-50 hover:bg-purple-100 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 text-purple-700 dark:text-purple-300 font-medium disabled:opacity-40 transition-colors">✨ Explain Results</button>
          <button disabled={rows.length === 0} className="w-full text-left px-3 py-2 text-sm rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/30 dark:hover:bg-green-900/50 text-green-700 dark:text-green-300 font-medium disabled:opacity-40 transition-colors">📥 Export CSV</button>
        </div>
      </aside>
    </div>
  );
}
