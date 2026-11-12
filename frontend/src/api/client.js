/**
 * API client — when running inside Tauri, proxies all requests through Rust
 * (invoke api_get / api_post) to avoid WebView CSP restrictions.
 * Falls back to plain fetch for browser-only dev.
 */

let _invoke = null;

async function getInvoke() {
  if (_invoke) return _invoke;
  if (window.__TAURI__) {
    const mod = await import("@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return _invoke;
}

/**
 * Resolve once the backend answers /api/health. Never rejects and never shows an
 * error: the backend may still be starting, or restarting after "Restart Backend".
 * onWaiting() fires once if the first ping fails. shouldStop() aborts the wait
 * (returns false in that case).
 */
export async function waitForBackend({ onWaiting, shouldStop, intervalMs = 500 } = {}) {
  let notified = false;
  for (;;) {
    if (shouldStop?.()) return false;
    try {
      await api("/api/health");
      return true;
    } catch {
      if (!notified) { notified = true; onWaiting?.(); }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const invoke = await getInvoke();

  // ── Tauri path: proxy through Rust commands (no CSP) ──────────────────────
  if (invoke) {
    try {
      if (method === "GET") {
        return await invoke("api_get", { path });
      } else {
        const body = opts.body ? JSON.parse(opts.body) : {};
        return await invoke("api_post", { path, body });
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Request failed") || msg.includes("Connection refused")) {
        throw new Error(
          `Cannot reach the backend server.\n` +
          `Start it with: npm run dev:backend\n` +
          `Detail: ${msg}`
        );
      }
      throw new Error(msg);
    }
  }

  // ── Browser / plain fetch fallback ────────────────────────────────────────
  const port = window.__SF_BACKEND_PORT__ || 7891;
  const url  = `http://localhost:${port}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
  } catch (e) {
    throw new Error(
      `Cannot reach backend at ${url}\n` +
      `Make sure the Python backend is running: cd backend && .venv/bin/python main.py\n` +
      `Detail: ${e?.name}: ${e?.message}`
    );
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    let detail = body;
    try { detail = JSON.parse(body)?.detail || body; } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${path}\n${detail}`);
  }
  return res.json();
}

export async function apiStream(path, body, onDelta, onDone, onError) {
  // Streaming SSE must use fetch directly (Tauri IPC doesn't support streaming)
  const port = window.__SF_BACKEND_PORT__ || 7891;
  const url  = `http://localhost:${port}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    onError(`Cannot reach backend: ${e?.message}`);
    return;
  }
  if (!res.ok) { onError(await res.text()); return; }
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { onDone(); return; }
      try {
        const obj = JSON.parse(payload);
        if (obj.error) { onError(obj.error); return; }
        if (obj.delta) onDelta(obj.delta);
      } catch {}
    }
  }
  onDone();
}

export async function openDirDialog() {
  if (window.__TAURI__) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true });
    return result || null;
  }
  // Browser/dev mode — prompt for a path via simple text input
  const path = window.prompt("Enter output folder path (leave blank for ~/Downloads):");
  if (path === null) return null;          // user clicked Cancel
  return path.trim() || "__default__";    // blank → default
}

export async function openSaveDialog(opts = {}) {
  if (window.__TAURI__) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save(opts);
  }
  return null;
}
