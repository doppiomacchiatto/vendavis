import { useState, useRef, useEffect } from "react";
import { api, apiStream } from "../api/client";
import Spinner from "../components/Spinner";

const PLACEHOLDER = `// Anonymous Apex
System.debug('Hello from ' + UserInfo.getName());`;

const LOG_LEVELS = ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"];

// Matches Salesforce Developer Console debug categories + their defaults
const CATEGORIES = [
  { key: "Database",      label: "Db",             default: "INFO"  },
  { key: "Workflow",      label: "Workflow",        default: "DEBUG" },
  { key: "Validation",    label: "Validation",      default: "NONE"  },
  { key: "Callout",       label: "Callouts",        default: "NONE"  },
  { key: "ApexCode",      label: "Apex Code",       default: "DEBUG" },
  { key: "ApexProfiling", label: "Apex Profiling",  default: "NONE"  },
];

function initLevels() {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, c.default]));
}

const FILTERS = [
  { id: "all",        label: "All" },
  { id: "user_debug", label: "USER_DEBUG" },
  { id: "limits",     label: "Limits"     },
  { id: "errors",     label: "Errors"     },
];

function filterLine(line, filterId) {
  if (filterId === "all")        return true;
  if (filterId === "user_debug") return line.includes("|USER_DEBUG|");
  if (filterId === "limits")     return line.includes("|CUMULATIVE_LIMIT_USAGE") || line.includes("|LIMIT_USAGE_FOR_NS|") || line.startsWith("Number of ");
  if (filterId === "errors")     return line.includes("|FATAL_ERROR|") || line.includes("|EXCEPTION_THROWN|");
  return true;
}

// ─── AI Chat Panel ────────────────────────────────────────────────────────────

const QUICK_CHIPS = [
  { label: "✨ Explain",     prompt: "Explain what this Apex code does, step by step." },
  { label: "🔧 Fix",         prompt: "There is an error in this Apex code. Identify and fix it." },
  { label: "🧪 Write Test",  prompt: "Write an Apex test class for this code with at least 80% coverage." },
  { label: "⚡ Optimize",   prompt: "Optimize this Apex code for performance and governor limits." },
];

function AiPanel({ code, lastLog, onInsert, onClose }) {
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState("");
  const [streaming,    setStreaming]     = useState(false);
  const [streamBuf,    setStreamBuf]    = useState("");
  const bottomRef  = useRef(null);

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamBuf]);

  function buildSystemPrompt() {
    let sys = `You are an expert Salesforce Apex developer embedded in Vendavis, a Salesforce metadata tool.
Help the user write, debug, and improve Apex code.
When providing code, wrap it in a \`\`\`apex code block.
Be concise and direct. No need to repeat the question.`;
    if (code.trim()) {
      sys += `\n\nCurrent editor code:\n\`\`\`apex\n${code}\n\`\`\``;
    }
    if (lastLog.trim()) {
      sys += `\n\nLast execution log (last 50 lines):\n\`\`\`\n${lastLog.split("\n").slice(-50).join("\n")}\n\`\`\``;
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
      { messages: newMessages, system: buildSystemPrompt() },
      // onDelta
      (delta) => {
        fullText += delta;
        setStreamBuf(fullText);
      },
      // onDone
      () => {
        setMessages((prev) => [...prev, { role: "assistant", content: fullText }]);
        setStreaming(false);
        setStreamBuf("");
      },
      // onError
      (errMsg) => {
        const isNoKey = errMsg.includes("No Anthropic API key");
        const display = isNoKey
          ? "🔑 No API key configured. Click **⚙ Settings** in the top bar, paste your Anthropic API key, and hit Save."
          : `⚠ Error: ${errMsg}`;
        setMessages((prev) => [...prev, { role: "assistant", content: display }]);
        setStreaming(false);
        setStreamBuf("");
      },
    );
  }

  // Parse assistant message for code blocks — returns array of {type:"text"|"code", content}
  function parseBlocks(text) {
    const parts = [];
    const re = /```(?:apex|javascript|java|soql)?\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ type: "text",  content: text.slice(last, m.index) });
      parts.push({ type: "code", content: m[1].trimEnd() });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: "text", content: text.slice(last) });
    return parts;
  }

  function AssistantMessage({ content }) {
    const blocks = parseBlocks(content);
    return (
      <div className="flex flex-col gap-2">
        {blocks.map((b, i) => {
          if (b.type === "text") {
            return (
              <p key={i} className="text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">
                {b.content}
              </p>
            );
          }
          return (
            <div key={i} className="relative group">
              <pre className="text-xs font-mono bg-gray-950 border border-gray-700 rounded p-3 overflow-x-auto text-green-300 leading-5">
                {b.content}
              </pre>
              <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onInsert("replace", b.content)}
                  className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
                  title="Replace editor contents"
                >
                  → Replace
                </button>
                <button
                  onClick={() => onInsert("append", b.content)}
                  className="px-2 py-0.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded font-medium"
                  title="Append to editor"
                >
                  + Append
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 border-l border-gray-700">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-white flex items-center gap-1.5">
          ✨ <span>Claude AI</span>
        </span>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={() => { setMessages([]); setStreamBuf(""); }}
              className="text-xs text-gray-400 hover:text-red-400 transition-colors"
              title="Clear conversation"
            >
              🗑 Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors text-sm leading-none"
            title="Close AI panel"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Quick chips */}
      <div className="shrink-0 flex flex-wrap gap-1.5 px-3 py-2 border-b border-gray-700/50">
        {QUICK_CHIPS.map((c) => (
          <button
            key={c.label}
            disabled={streaming}
            onClick={() => sendMessage(c.prompt)}
            className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 rounded-full border border-gray-600 transition-colors font-medium"
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4 min-h-0">
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-gray-500 text-center pt-6 leading-relaxed px-4">
            Ask anything about Apex, or use a quick chip above.<br />
            <span className="text-gray-600">Your editor code and last log are sent as context.</span>
            <div className="mt-4 p-3 bg-gray-800 rounded-lg border border-gray-700 text-left">
              <p className="text-yellow-400 font-semibold mb-1">⚙ First time setup</p>
              <p className="text-gray-400">Click <strong className="text-white">⚙ Settings</strong> in the top bar and paste your Anthropic API key to get started.</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {msg.role === "user" ? (
              <div className="max-w-[90%] bg-blue-700 text-white text-xs px-3 py-2 rounded-2xl rounded-tr-sm leading-relaxed">
                {msg.content}
              </div>
            ) : (
              <div className="w-full">
                <AssistantMessage content={msg.content} />
              </div>
            )}
          </div>
        ))}

        {/* Streaming buffer */}
        {streaming && streamBuf && (
          <div className="w-full">
            <AssistantMessage content={streamBuf} />
          </div>
        )}
        {streaming && !streamBuf && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Spinner label="" />
            <span>Claude is thinking…</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2 border-t border-gray-700">
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 min-h-[36px] max-h-32 text-xs font-sans border border-gray-600 rounded-lg px-3 py-2 bg-gray-800 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none leading-5"
            placeholder="Ask Claude about your Apex code…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            rows={1}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={streaming || !input.trim()}
            className="shrink-0 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors"
          >
            ↑
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">↵ send &nbsp;·&nbsp; Shift+↵ newline</p>
      </div>
    </div>
  );
}

// ─── Main ApexRunner ──────────────────────────────────────────────────────────

export default function ApexRunner({ org, onApiCall }) {
  const [code,        setCode]        = useState(PLACEHOLDER);
  const [output,      setOutput]      = useState("");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [levels,      setLevels]      = useState(initLevels);
  const [resultFilter,setResultFilter]= useState("all");
  const [debugOpen,   setDebugOpen]   = useState(false);
  const [debugLog,    setDebugLog]    = useState([]);
  const [aiOpen,      setAiOpen]      = useState(false);

  function setLevel(key, val) {
    setLevels((prev) => ({ ...prev, [key]: val }));
  }

  function log(msg, type = "info") {
    const ts   = new Date().toISOString().slice(11, 23);
    const icon = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
    setDebugLog((l) => [...l, { ts, icon, msg }]);
    if (type === "error") setDebugOpen(true);
  }

  // Build a log level string for the SF CLI: highest level wins across categories
  function effectiveLogLevel() {
    const order = LOG_LEVELS;
    let max = 0;
    Object.values(levels).forEach((v) => {
      const idx = order.indexOf(v);
      if (idx > max) max = idx;
    });
    return order[max];
  }

  async function runApex() {
    if (!org) { setError("Select an org first."); return; }
    setLoading(true); setError(""); setOutput(""); setResultFilter("all");
    const level = effectiveLogLevel();
    log(`Executing on ${org.alias} — effective log level: ${level}`);
    try {
      const d = await api("/api/apex", {
        method: "POST",
        body: JSON.stringify({ alias: org.alias, code, log_level: level }),
      });
      if (d.error) setError(d.error);
      const raw = d.output || "";
      setOutput(raw);
      const lineCount = raw ? raw.split("\n").filter(Boolean).length : 0;
      log(`Done — ${lineCount} log line(s)`, "success");
      // Refresh global API limit counter
      onApiCall?.();
    } catch (e) {
      setError(e.message);
      log(e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  function handleAiInsert(mode, snippet) {
    if (mode === "replace") {
      setCode(snippet);
    } else {
      setCode((c) => c + "\n" + snippet);
    }
  }

  // Row 1: Db, Workflow, Validation
  // Row 2: Callouts, Apex Code, Apex Profiling
  const row1 = CATEGORIES.slice(0, 3);
  const row2 = CATEGORIES.slice(3);

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: editor + controls ─────────────────────────────────────────── */}
      <div className={`flex flex-col overflow-hidden transition-all duration-200 ${aiOpen ? "w-1/2" : "flex-1"}`}>

        {/* Code editor */}
        <div className="flex-1 min-h-0 p-3 pb-0">
          <textarea
            className="w-full h-full font-mono text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runApex(); } }}
            spellCheck={false}
            placeholder="// Anonymous Apex"
          />
        </div>

        {/* Debug Levels bar */}
        <div className="shrink-0 border-t border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-3 py-2 flex flex-col gap-1.5">
          {[row1, row2].map((row, ri) => (
            <div key={ri} className="flex items-center gap-4 flex-wrap">
              {ri === 0 && (
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap w-24">
                  Debug Levels
                </span>
              )}
              {ri === 1 && <span className="w-24" />}
              {row.map((cat) => (
                <div key={cat.key} className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap font-medium">
                    {cat.label}
                  </label>
                  <select
                    value={levels[cat.key]}
                    onChange={(e) => setLevel(cat.key, e.target.value)}
                    className="text-xs border border-gray-300 dark:border-gray-500 rounded px-1.5 py-0.5 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {LOG_LEVELS.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Execute button row */}
        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={runApex}
            disabled={loading}
            className="px-5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-sm font-semibold transition-colors"
          >
            {loading ? <Spinner label="Running…" /> : "Execute"}
          </button>
          <span className="text-xs text-gray-400 dark:text-gray-500">⌘↵</span>
          {(output || error) && (
            <button
              onClick={() => { setOutput(""); setError(""); }}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              ✕ Clear
            </button>
          )}
          <button
            onClick={() => setAiOpen((o) => !o)}
            className={`ml-auto px-3 py-1.5 rounded text-sm font-semibold transition-colors border ${
              aiOpen
                ? "bg-violet-700 hover:bg-violet-800 text-white border-violet-600"
                : "bg-gray-100 dark:bg-gray-700 hover:bg-violet-50 dark:hover:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-700"
            }`}
            title="Toggle Claude AI assistant"
          >
            ✨ AI
          </button>
        </div>

        {/* Results panel */}
        {(output || error) && (
          <div className="shrink-0 max-h-72 flex flex-col border-t border-gray-300 dark:border-gray-600">
            {/* Results header + filter toggles */}
            <div className="px-3 py-1 bg-gray-200 dark:bg-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300 flex items-center gap-3 shrink-0 flex-wrap">
              <span>Results</span>
              {!error && <span className="text-green-600 dark:text-green-400">✓ Compiled &amp; Executed</span>}
              {error  && <span className="text-red-500">✗ Error</span>}
              <div className="ml-auto flex items-center gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setResultFilter(f.id)}
                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                      resultFilter === f.id
                        ? "bg-blue-600 text-white"
                        : "bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-400 dark:hover:bg-gray-500"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Compile/runtime error */}
            {error && (
              <div className="px-3 py-2 text-xs font-mono text-red-400 bg-red-950/40 shrink-0 whitespace-pre-wrap">
                {error}
              </div>
            )}
            {/* Log lines — Dev Console style */}
            {output && (
              <div className="flex-1 overflow-auto bg-gray-950 font-mono text-xs min-h-0">
                {output.split("\n").filter(Boolean).filter((l) => filterLine(l, resultFilter)).map((line, i) => {
                  const isUserDebug = line.includes("|USER_DEBUG|");
                  const isMilestone = line.includes("|EXECUTION_") || line.includes("|CODE_UNIT_");
                  const debugMatch = isUserDebug && line.match(/\|USER_DEBUG\|\[\d+\]\|[A-Z]+\|(.*)/);
                  const debugValue = debugMatch ? debugMatch[1] : null;
                  return (
                    <div
                      key={i}
                      className={`px-3 py-0.5 leading-5 border-b border-gray-800/50 ${
                        isUserDebug
                          ? "text-green-300 bg-green-950/20"
                          : isMilestone
                          ? "text-blue-400 bg-blue-950/10"
                          : "text-gray-500"
                      }`}
                    >
                      {isUserDebug && debugValue ? (
                        <>
                          <span className="text-gray-600 mr-2 select-none">{line.split("|")[0]}</span>
                          <span className="text-yellow-400 mr-2">USER_DEBUG</span>
                          <span className="text-green-300">{debugValue}</span>
                        </>
                      ) : (
                        line
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Debug log (collapsible) */}
        <div className={`border-t-2 border-gray-300 dark:border-gray-600 flex flex-col shrink-0 ${debugOpen ? "h-36" : "h-auto"}`}>
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="flex items-center justify-between px-4 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs font-mono font-semibold text-gray-600 dark:text-gray-300 transition-colors w-full text-left"
          >
            <span>🔍 Debug Log {debugLog.length > 0 && `(${debugLog.length})`}</span>
            <span className="text-gray-400">{debugOpen ? "▼ collapse" : "▲ expand"}</span>
          </button>
          {debugOpen && (
            <div className="flex-1 overflow-y-auto bg-gray-900 px-3 py-2 font-mono text-xs">
              {debugLog.length === 0
                ? <span className="text-gray-500">No log entries yet.</span>
                : debugLog.map((e, i) => (
                  <div key={i} className="flex gap-2 leading-5">
                    <span className="text-gray-500 shrink-0">{e.ts}</span>
                    <span className="shrink-0">{e.icon}</span>
                    <span className="text-green-300 break-all">{e.msg}</span>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Claude AI panel ──────────────────────────────────────────── */}
      {aiOpen && (
        <div className="w-1/2 flex flex-col overflow-hidden border-l border-gray-300 dark:border-gray-700">
          <AiPanel
            code={code}
            lastLog={output}
            onInsert={handleAiInsert}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
