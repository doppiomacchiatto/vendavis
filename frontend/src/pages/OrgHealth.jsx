/**
 * OrgHealth — dedicated dashboard tab for Org Health Check.
 * Phases: "preflight" → "running" → "done"
 */
import { useState, useRef, useEffect } from "react";
import { api } from "../api/client";
import Spinner from "../components/Spinner";
import DebugLogPanel from "../components/DebugLogPanel";
import {
  HEALTH_CHECKS, CHECK_CATEGORIES,
  CATEGORY_ICONS, STATUS_ICON, STATUS_COLOR,
} from "../data/healthChecks";

// ── Drill-down table ──────────────────────────────────────────────────────────
function DrillTable({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0)
    return <p className="text-xs text-slate-400">No records returned.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700/50">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-800/80">
            {cols.map(c => (
              <th key={c} className="px-2 py-1.5 text-left text-slate-300 font-semibold whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-slate-700/30 hover:bg-slate-800/40">
              {cols.map(c => (
                <td key={c} className="px-2 py-1.5 text-slate-200 font-mono whitespace-nowrap">
                  {row[c] == null ? <span className="text-slate-400 italic">null</span> : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Single check row ──────────────────────────────────────────────────────────
function CheckRow({ chk, result, org }) {
  const [open,      setOpen]      = useState(false);
  const [drillRows, setDrillRows] = useState(null); // null | "loading" | "error" | []

  const isRunning = result === null;
  const status    = isRunning ? "running" : (result?.status ?? "info");
  const canExpand = !isRunning && result && (status === "warn" || status === "fail");

  async function loadDrill() {
    if (!chk.drillQuery || drillRows) return;
    setDrillRows("loading");
    try {
      const res = await api("/api/soql", { method: "POST", body: JSON.stringify({ alias: org.alias, query: chk.drillQuery }) });
      setDrillRows(res.records || []);
    } catch {
      setDrillRows("error");
    }
  }

  function toggle() {
    if (!canExpand) return;
    const opening = !open;
    setOpen(opening);
    if (opening) loadDrill();
  }

  const borderCls = status === "fail" ? "border-red-700/60 bg-red-950/20"
    : status === "warn"               ? "border-yellow-700/60 bg-yellow-950/10"
    : "border-slate-700/40 bg-slate-800/30";

  return (
    <div className={`rounded-lg border overflow-hidden ${borderCls}`}>
      {/* Row header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm shrink-0">
          {isRunning ? <span className="animate-pulse">⏳</span> : STATUS_ICON[status]}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-white">{chk.label}</p>
          {!isRunning && result?.detail && (
            <p className={`text-xs mt-0.5 ${STATUS_COLOR[status]}`}>{result.detail}</p>
          )}
          {isRunning && <p className="text-xs text-slate-400 mt-0.5 animate-pulse">Running…</p>}
        </div>
        {canExpand && (
          <button onClick={toggle}
            className={`shrink-0 text-xs px-2 py-1 rounded-md border transition-colors font-medium ${
              status === "fail"
                ? "border-red-700 text-red-300 hover:bg-red-900/40"
                : "border-yellow-700 text-yellow-300 hover:bg-yellow-900/40"
            }`}>
            {open ? "▲ Hide" : "▼ Details"}
          </button>
        )}
      </div>

      {/* Expanded panel */}
      {canExpand && open && (
        <div className={`border-t px-4 py-3 flex flex-col gap-3 ${
          status === "fail" ? "border-red-800/50" : "border-yellow-800/50"
        }`}>
          {chk.tip && (
            <div className="flex gap-2">
              <span className="shrink-0 text-base">💡</span>
              <div>
                <p className="text-xs font-semibold text-slate-200 mb-1">How to fix</p>
                <p className="text-xs text-slate-300 leading-relaxed">{chk.tip}</p>
              </div>
            </div>
          )}
          {chk.drillQuery && (
            <div>
              <p className="text-xs font-semibold text-slate-200 mb-1.5">📋 Records</p>
              {drillRows === "loading" && <p className="text-xs text-slate-400 animate-pulse">Loading…</p>}
              {drillRows === "error"   && <p className="text-xs text-red-400">Could not load records.</p>}
              {Array.isArray(drillRows) && <DrillTable rows={drillRows} />}
              <p className="text-xs text-blue-600 mt-1.5 font-mono break-all">{chk.drillQuery}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Category summary card ─────────────────────────────────────────────────────
function CategoryCard({ cat, checks, results, onClick, active, onRerun, phase }) {
  const catResults = checks.map(c => results[c.id]).filter(r => r !== null && r !== undefined);
  const fails  = catResults.filter(r => r?.status === "fail").length;
  const warns  = catResults.filter(r => r?.status === "warn").length;
  const done   = checks.filter(c => results[c.id] !== null && results[c.id] !== undefined).length;
  const total  = checks.length;
  const allDone = done === total;

  const badgeCls = fails > 0 ? "bg-red-500"
    : warns > 0              ? "bg-yellow-500"
    : allDone                ? "bg-green-500"
    : "bg-blue-600";

  return (
    <div className={`flex flex-col gap-1 p-3 rounded-xl border text-left transition-all ${
      active
        ? "border-blue-400 bg-slate-700/60 shadow-lg shadow-slate-900/60"
        : "border-slate-700/60 bg-slate-800/40"
    }`}>
      <button onClick={onClick} className="flex flex-col gap-1 flex-1 text-left">
        <div className="flex items-center justify-between">
          <span className="text-lg">{CATEGORY_ICONS[cat] || "📋"}</span>
          {(fails > 0 || warns > 0) && (
            <span className={`text-xs font-bold text-white px-1.5 py-0.5 rounded-full ${badgeCls}`}>
              {fails > 0 ? `${fails} ❌` : `${warns} ⚠️`}
            </span>
          )}
          {allDone && fails === 0 && warns === 0 && (
            <span className="text-green-400 text-xs">✅</span>
          )}
          {!allDone && (
            <span className="text-slate-400 text-xs">{done}/{total}</span>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-white">{cat}</p>
          <p className="text-xs text-slate-400 mt-0.5">{total} checks</p>
        </div>
      </button>
      {phase === "done" && onRerun && (
        <button
          onClick={(e) => { e.stopPropagation(); onRerun(cat); }}
          className="mt-1 w-full px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-400 hover:text-slate-200 text-xs transition-colors">
          ↺ Re-run
        </button>
      )}
    </div>
  );
}

// ── Main OrgHealth page ───────────────────────────────────────────────────────
export default function OrgHealth({ org, onApiCall }) {
  const [phase,    setPhase]    = useState("preflight"); // preflight|running|done
  const [results,  setResults]  = useState({});
  const [current,  setCurrent]  = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [runScope, setRunScope] = useState(null); // null = all, string = single category
  const [debugLog,  setDebugLog]  = useState([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const cancelRef = useRef(false);
  const lastOrg   = useRef(null);

  function log(msg, type = "info") {
    const ts = new Date().toISOString().slice(11, 23);
    const icon = type === "error" ? "❌" : type === "success" ? "✅" : type === "warn" ? "⚠️" : "ℹ️";
    setDebugLog((l) => [...l, { ts, icon, msg }]);
    if (type === "error") setDebugOpen(true);
  }

  // Reset when org changes
  useEffect(() => {
    if (org?.alias !== lastOrg.current) {
      lastOrg.current = org?.alias ?? null;
      setPhase("preflight");
      setResults({});
      setCurrent(null);
      setActiveCategory(null);
      setRunScope(null);
    }
  }, [org]);

  // filterCat: undefined/null = run all; string = run only that category
  function startChecks(filterCat) {
    cancelRef.current = false;
    const checksToRun = filterCat
      ? HEALTH_CHECKS.filter(c => c.category === filterCat)
      : HEALTH_CHECKS;
    setRunScope(filterCat ?? null);
    setPhase("running");
    setDebugLog([]);
    log(`Starting ${checksToRun.length} check(s)${filterCat ? ` in ${filterCat}` : ""}…`);
    // Keep existing results for other categories when running a single one
    if (filterCat) {
      setResults(r => {
        const cleared = { ...r };
        checksToRun.forEach(c => { cleared[c.id] = undefined; });
        return cleared;
      });
    } else {
      setResults({});
    }
    setActiveCategory(filterCat ?? CHECK_CATEGORIES[0]);
    runChecks(checksToRun);
  }

  async function runChecks(checksToRun) {
    for (let i = 0; i < checksToRun.length; i++) {
      if (cancelRef.current) break;
      const chk = checksToRun[i];
      setCurrent({ idx: i, total: checksToRun.length, label: chk.label, category: chk.category });
      setResults(r => ({ ...r, [chk.id]: null }));
      const t0 = Date.now();
      try {
        const result = await chk.run(org.alias, api);
        const ms = Date.now() - t0;
        if (!cancelRef.current) {
          setResults(r => ({ ...r, [chk.id]: result }));
          onApiCall?.();
          const type = result?.status === "fail" ? "error" : result?.status === "warn" ? "warn" : "success";
          log(`${chk.label} — ${result?.status ?? "done"} (${ms}ms)`, type);
        }
      } catch (e) {
        const ms = Date.now() - t0;
        if (!cancelRef.current) {
          setResults(r => ({ ...r, [chk.id]: { status: "fail", detail: e.message } }));
          log(`${chk.label} — error: ${e.message} (${ms}ms)`, "error");
        }
      }
    }
    if (!cancelRef.current) {
      setCurrent(null);
      setPhase("done");
      log(`All checks complete.`, "success");
    }
  }

  const allResults = Object.values(results).filter(r => r !== null && r !== undefined);
  const total   = HEALTH_CHECKS.length;
  const checked = allResults.length;
  const fails   = allResults.filter(r => r?.status === "fail").length;
  const warns   = allResults.filter(r => r?.status === "warn").length;
  const passes  = allResults.filter(r => r?.status === "pass").length;

  // ── Preflight ──────────────────────────────────────────────────────────────
  if (phase === "preflight") return (
    <div className="flex flex-col h-full bg-slate-900">
      <div className="shrink-0 px-6 py-4 bg-slate-800 border-b border-slate-700">
        <h1 className="text-lg font-bold text-white">🏥 Org Health Check</h1>
        {org && <p className="text-xs text-slate-300 mt-0.5">Connected org: <span className="font-mono">{org.alias}</span> · <span className="text-slate-400">{org.username}</span></p>}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        <div className="px-4 py-3 bg-slate-800/60 rounded-xl border border-slate-700">
          <p className="text-sm font-semibold text-white mb-1">What this does</p>
          <p className="text-xs text-slate-300 leading-relaxed">
            Runs <strong className="text-white">{total} read-only checks</strong> across {CHECK_CATEGORIES.length} categories.
            No data is modified. Each check calls your org's API or runs a SOQL COUNT() query.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CHECK_CATEGORIES.map(cat => {
            const checks = HEALTH_CHECKS.filter(c => c.category === cat);
            return (
              <div key={cat} className="p-3 bg-slate-800/40 rounded-xl border border-slate-700/60 flex flex-col gap-2">
                <div>
                  <p className="text-sm mb-1">{CATEGORY_ICONS[cat]}</p>
                  <p className="text-xs font-semibold text-white">{cat}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{checks.length} checks</p>
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  {checks.map(c => (
                    <p key={c.id} className="text-xs text-slate-500 truncate">◦ {c.label}</p>
                  ))}
                </div>
                <button
                  disabled={!org}
                  onClick={() => startChecks(cat)}
                  className="mt-1 w-full px-2 py-1.5 rounded-lg bg-slate-700 hover:bg-blue-700 disabled:opacity-40 text-slate-200 text-xs font-semibold transition-colors border border-slate-600">
                  ▶ Run {cat}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 px-6 py-4 border-t border-slate-700 bg-slate-800/60 flex gap-3">
        <button
          disabled={!org}
          onClick={() => startChecks()}
          className="flex-1 px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold transition-colors">
          ▶ Run All {total} Checks
        </button>
      </div>
    </div>
  );

  // ── Running + Done layout ──────────────────────────────────────────────────
  const displayCat   = activeCategory ?? CHECK_CATEGORIES[0];
  const catChecks    = HEALTH_CHECKS.filter(c => c.category === displayCat);

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-bold text-white">🏥 Org Health Check</h1>
          {org && <p className="text-xs text-slate-400 font-mono">{org.alias}</p>}
        </div>
        <div className="flex items-center gap-3">
          {phase === "done" && (
            <span className="text-xs">
              {fails > 0  && <span className="text-red-400 font-semibold mr-2">❌ {fails} failed</span>}
              {warns > 0  && <span className="text-yellow-400 font-semibold mr-2">⚠️ {warns} warnings</span>}
              {fails === 0 && warns === 0 && <span className="text-green-400 font-semibold">✅ All clear</span>}
            </span>
          )}
          {phase === "done" && (
            <button onClick={() => { setPhase("preflight"); setResults({}); setActiveCategory(null); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-blue-500 transition-colors">
              ↺ Re-run
            </button>
          )}
        </div>
      </div>

      {/* Progress bar (running only) */}
      {phase === "running" && (
        <div className="shrink-0 px-4 py-2 bg-slate-800/50 border-b border-slate-700/50">
          <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
            <span>
              {current
                ? `Check ${current.idx + 1} of ${current.total} — ${current.label}`
                : "Starting…"}
              {runScope && <span className="ml-2 text-slate-400">({runScope} only)</span>}
            </span>
            <span>{current ? current.idx + 1 : 0}/{current?.total ?? 0}</span>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div className="h-full bg-blue-400 rounded-full transition-all duration-300"
              style={{ width: `${current?.total ? ((current.idx + 1) / current.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {/* Summary banner (done only) */}
      {phase === "done" && (
        <div className="shrink-0 px-4 py-2 border-b border-slate-700 flex items-center gap-3 bg-slate-800/30">
          <div className="flex gap-4 text-xs">
            <span className="text-red-400 font-semibold">❌ {fails} failed</span>
            <span className="text-yellow-400 font-semibold">⚠️ {warns} warnings</span>
            <span className="text-green-400 font-semibold">✅ {passes} passed</span>
            <span className="text-slate-400">ℹ️ {checked - fails - warns - passes} info</span>
          </div>
        </div>
      )}

      {/* Body: category cards left + detail right */}
      <div className="flex-1 flex min-h-0">
        {/* Left: category card grid */}
        <div className="w-52 shrink-0 flex flex-col gap-2 p-3 border-r border-slate-700 overflow-y-auto">
          {CHECK_CATEGORIES.map(cat => (
            <CategoryCard
              key={cat}
              cat={cat}
              checks={HEALTH_CHECKS.filter(c => c.category === cat)}
              results={results}
              active={displayCat === cat}
              onClick={() => setActiveCategory(cat)}
              onRerun={startChecks}
              phase={phase}
            />
          ))}
        </div>

        {/* Right: checks for selected category */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{CATEGORY_ICONS[displayCat]}</span>
            <h2 className="text-sm font-bold text-white">{displayCat}</h2>
            <span className="text-xs text-slate-400">{catChecks.length} checks</span>
          </div>
          {catChecks.map(chk => (
            <CheckRow
              key={chk.id}
              chk={chk}
              result={results[chk.id]}
              org={org}
            />
          ))}
          {catChecks.every(c => results[c.id] === undefined) && phase !== "done" && (
            <div className="text-center text-slate-400 text-xs mt-8">
              {phase === "running" ? "Checks for this category haven't started yet…" : ""}
            </div>
          )}
        </div>
      </div>

      {/* ── Debug log ───────────────────────────────────────────────────────── */}
      <DebugLogPanel
        entries={debugLog}
        open={debugOpen}
        onToggle={() => setDebugOpen((o) => !o)}
        onClear={() => setDebugLog([])}
      />
    </div>
  );
}
