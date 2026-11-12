import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Apply saved theme before first render to avoid flash
(function applyInitialTheme() {
  try {
    const port = window.__SF_BACKEND_PORT__ || 7891;
    // Synchronous fetch not available; use a best-effort immediate OS check.
    // The settings useEffect in App.jsx will correct it once the API responds.
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    // Check localStorage cache set by previous session
    const cached = localStorage.getItem("avio_theme");
    const dark =
      cached === "dark" ||
      ((!cached || cached === "system") && prefersDark);
    document.documentElement.classList.toggle("dark", dark);
  } catch (_) {}
})();

ReactDOM.createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
