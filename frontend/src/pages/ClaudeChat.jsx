/**
 * Claude AI chat page — full RAG pipeline:
 * fuzzy object matching, field loading, SOQL generation.
 */
import { useState, useRef, useEffect } from "react";
import { api, apiStream } from "../api/client";
import Spinner from "../components/Spinner";

export default function ClaudeChat({ org, ctx, setCtx }) {
  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState("");
  const [streaming, setStreaming] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  function buildSystem() {
    const objList = (ctx.objects || [])
      .map((o, i) => `${i + 1}. ${o.apiName} — ${o.label}`)
      .join("\n");
    return [
      "You are a Salesforce expert assistant embedded in SF Metadata Explorer.",
      "When the user asks about a Salesforce object, match it against this exact list and use the API name precisely:",
      "",
      objList || "(No objects loaded — ask the user to select an org first.)",
      "",
      "When you identify an object to query, output a tag: [SELECT_OBJECT: ApiName__c]",
      "Always use the exact API names from the list above.",
    ].join("\n");
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");

    const userMsg = { role: "user", content: text };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setStreaming(true);

    // Placeholder for assistant reply
    const placeholder = { role: "assistant", content: "" };
    setMessages((m) => [...m, placeholder]);

    let full = "";
    await apiStream(
      "/api/claude/chat",
      { messages: newMsgs, system: buildSystem() },
      (delta) => {
        full += delta;
        setMessages((m) => {
          const updated = [...m];
          updated[updated.length - 1] = { role: "assistant", content: full };
          return updated;
        });
      },
      () => {
        setStreaming(false);
        // Check for [SELECT_OBJECT: ...] action tag
        const match = full.match(/\[SELECT_OBJECT:\s*([^\]]+)\]/);
        if (match) handleSelectObject(match[1].trim(), newMsgs, full);
      },
      (err) => {
        setStreaming(false);
        setMessages((m) => {
          const updated = [...m];
          updated[updated.length - 1] = { role: "assistant", content: `❌ ${err}` };
          return updated;
        });
      }
    );
  }

  async function handleSelectObject(apiName, prevMsgs, prevReply) {
    if (!org) return;
    // Already have fields?
    if (ctx.fields?.[apiName]) return;

    setMessages((m) => [...m, {
      role: "assistant",
      content: `📦 Loading fields for **${apiName}**…`,
      system: true,
    }]);

    try {
      const d = await api(`/api/orgs/${org.alias}/objects/${apiName}/fields`);
      const fields = d.fields || [];
      setCtx((c) => ({ ...c, fields: { ...c.fields, [apiName]: fields } }));

      const fieldLines = fields.map((f) => `  ${f.apiName} (${f.type})`).join("\n");
      const autoMsg = {
        role: "user",
        content: `[System: Fields loaded for ${apiName}. Here are all ${fields.length} fields:\n\n${fieldLines}\n\nPlease now write the SOQL query using exact API field names above.]`,
      };
      const nextMsgs = [...prevMsgs, { role: "assistant", content: prevReply }, autoMsg];
      setMessages((m) => [...m, autoMsg]);

      setStreaming(true);
      const autoPlaceholder = { role: "assistant", content: "" };
      setMessages((m) => [...m, autoPlaceholder]);

      let autoFull = "";
      await apiStream(
        "/api/claude/chat",
        { messages: nextMsgs, system: buildSystem() },
        (delta) => {
          autoFull += delta;
          setMessages((m) => {
            const updated = [...m];
            updated[updated.length - 1] = { role: "assistant", content: autoFull };
            return updated;
          });
        },
        () => setStreaming(false),
        (err) => { setStreaming(false); console.error(err); }
      );
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `❌ Failed to load fields: ${e.message}`, system: true }]);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-16 text-sm">
            <p className="text-3xl mb-3">⚡</p>
            <p className="font-medium">Ask me to write a SOQL query, explain results, or anything Salesforce.</p>
            <p className="text-xs mt-1">I know all the objects and fields in your org.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-2xl rounded-2xl px-4 py-2.5 text-sm ${
              msg.role === "user"
                ? "bg-blue-600 text-white rounded-br-sm"
                : msg.system
                ? "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 border border-yellow-200 dark:border-yellow-700 rounded-bl-sm text-xs font-mono"
                : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-bl-sm"
            }`}>
              <MarkdownText text={msg.content} />
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-bl-sm px-4 py-2.5">
              <Spinner label="Thinking…" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-3 flex gap-2 bg-white dark:bg-gray-800">
        <textarea
          className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded-xl px-3 py-2 bg-white dark:bg-gray-700 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
          rows={2}
          placeholder="Ask about your org, request a SOQL query…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
          disabled={streaming}
        />
        <button
          onClick={sendMessage}
          disabled={streaming || !input.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl text-sm font-medium self-end transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// Minimal markdown renderer for bold/code/newlines
function MarkdownText({ text }) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**"))
          return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`"))
          return <code key={i} className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">{p.slice(1, -1)}</code>;
        return <span key={i}>{p.split("\n").map((ln, j) => <span key={j}>{ln}{j < p.split("\n").length - 1 && <br />}</span>)}</span>;
      })}
    </>
  );
}
