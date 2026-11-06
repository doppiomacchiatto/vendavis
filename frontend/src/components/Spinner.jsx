const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

import { useEffect, useState } from "react";

export default function Spinner({ label = "Loading…" }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-gray-500 font-mono">
      {FRAMES[frame]} {label}
    </span>
  );
}
