import { useSyncExternalStore } from "react";

const MAX_ENTRIES = 500;

let entries = [];
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const l of listeners) l();
}

export function debugLog(msg, level = "info") {
  const entry = { id: nextId++, ts: Date.now(), level, msg };
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
  emit();
  return entry;
}

export function clearDebugLog() {
  entries = [];
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDebugLog() {
  return useSyncExternalStore(subscribe, () => entries);
}
