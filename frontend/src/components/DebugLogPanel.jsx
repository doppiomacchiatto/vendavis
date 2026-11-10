import { useEffect, useRef, useState } from "react";

/**
 * Collapsible per-tab debug log with filter / copy / clear.
 * entries: [{ ts, icon, msg }]
 */
export default function DebugLogPanel({ entries, open, onToggle, onClear, heightClass = "h-36", className = "" }) {
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const endRef = useRef(null);

  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.msg.toLowerCase().includes(q)) : entries;

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [shown.length, open]);

  function copyAll() {
    const text = shown.map((e) => `${e.ts} ${e.msg}`).join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const btn =
    "text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-500 text-gray-600 dark:text-gray-300 " +
    "hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-40";

  return (
    <div className={`border-t-2 border-gray-300 dark:border-gray-600 flex flex-col ${open ? heightClass : "h-auto"} ${className}`}>
      <div className="flex items-center gap-2 px-4 py-1 bg-gray-100 dark:bg-gray-700 text-xs font-mono font-semibold text-gray-600 dark:text-gray-300">
        <button onClick={onToggle} className="flex-1 flex items-center justify-between text-left py-0.5 hover:text-gray-900 dark:hover:text-white">
          <span>🔍 Debug Log {entries.length > 0 && `(${entries.length})`}</span>
          <span className="text-gray-400 ml-2">{open ? "▼ collapse" : "▲ expand"}</span>
        </button>
        {open && (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="text-xs font-normal w-36 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-500 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 outline-none focus:border-blue-400"
            />
            <button onClick={copyAll} disabled={shown.length === 0} className={btn}>{copied ? "Copied" : "Copy"}</button>
            <button onClick={onClear} disabled={entries.length === 0} className={btn}>Clear</button>
          </>
        )}
      </div>

      {open && (
        <div className="flex-1 overflow-y-auto bg-gray-900 px-3 py-2 font-mono text-xs">
          {entries.length === 0 ? (
            <span className="text-gray-500">No log entries yet.</span>
          ) : shown.length === 0 ? (
            <span className="text-gray-500">No entries match "{filter}".</span>
          ) : (
            shown.map((e, i) => (
              <div key={i} className="flex gap-2 leading-5">
                <span className="text-gray-500 shrink-0">{e.ts}</span>
                <span className="shrink-0">{e.icon}</span>
                <span className="text-green-300 break-all">{e.msg}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
