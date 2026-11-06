import { useEffect, useState } from "react";

const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export default function LoadingOverlay({ message = "Loading…", subtitle, onCancel }) {
  const [frame,   setFrame]   = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const spinner = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    const timer   = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => { clearInterval(spinner); clearInterval(timer); };
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0
    ? `${mins}m ${String(secs).padStart(2, "0")}s`
    : `${secs}s`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-2xl shadow-2xl px-10 py-8 flex flex-col items-center gap-4 min-w-72">
        {/* Braille spinner */}
        <div className="text-5xl text-blue-400 leading-none select-none" style={{ fontFamily: "monospace" }}>
          {FRAMES[frame]}
        </div>

        {/* Message */}
        <div className="text-sm font-semibold text-white text-center">
          {message}
        </div>

        {/* Subtitle */}
        {subtitle && (
          <div className="text-xs text-gray-400 text-center max-w-xs leading-relaxed">
            {subtitle}
          </div>
        )}

        {/* Elapsed timer */}
        <div className="text-xs text-gray-400 font-mono">
          ⏱ {timeStr}
        </div>

        {/* Cancel */}
        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-1 text-sm text-red-400 hover:text-red-300 border border-red-500/50 hover:border-red-400 rounded-lg px-5 py-1.5 transition-colors"
          >
            ✕ Cancel
          </button>
        )}
      </div>
    </div>
  );
}
