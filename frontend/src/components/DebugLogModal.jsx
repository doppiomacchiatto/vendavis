import { useEffect, useRef, useState } from "react";
import { useDebugLog, clearDebugLog } from "../debugLog";

const LEVEL_STYLE = {
  info:  "text-green-400",
  start: "text-blue-300",
  done:  "text-green-300",
  warn:  "text-yellow-300",
  error: "text-red-400",
};

function fmt(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export default function DebugLogModal({ onClose }) {
  const entries = useDebugLog();
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const endRef = useRef(null);

  const shown = filter
    ? entries.filter((e) => e.msg.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);

  function copyAll() {
    const text = shown.map((e) => `${fmt(e.ts)} [${e.level}] ${e.msg}`).join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl mx-4 h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-[#1a2d5a] px-5 py-3 flex items-center gap-3">
          <h2 className="text-base font-bold text-white">🐞 Debug Log</h2>
          <span className="text-xs text-blue-200">{entries.length} entries</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="ml-auto text-xs rounded px-2 py-1 bg-blue-900/60 text-white placeholder-blue-300 border border-blue-400 outline-none w-40"
          />
          <button onClick={copyAll} className="text-xs bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-2 py-1 text-white">
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={clearDebugLog} className="text-xs bg-blue-600 hover:bg-blue-500 border border-blue-400 rounded px-2 py-1 text-white">
            Clear
          </button>
          <button onClick={onClose} className="text-blue-200 hover:text-white text-lg leading-none" title="Close">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto bg-gray-900 p-3 font-mono text-xs">
          {shown.length === 0 ? (
            <div className="text-gray-500">No entries yet.</div>
          ) : (
            shown.map((e) => (
              <div key={e.id} className={`whitespace-pre-wrap ${LEVEL_STYLE[e.level] || LEVEL_STYLE.info}`}>
                <span className="text-gray-500">{fmt(e.ts)}</span> {e.msg}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
