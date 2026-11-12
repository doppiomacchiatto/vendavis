"""
Persistent "restore snapshot" for the Validation Rules bulk Disable All.

Remembers which rules were active before a bulk disable, so Restore still works
after switching objects/tabs or restarting the app. Stored as JSON in
~/.vendavis_vr_snapshots.json:

{
  "version": 1,
  "snapshots": {
    "<org alias>": {
      "<Object API name>": { "rules": ["Rule_A", "Rule_B"], "savedAt": "2026-11-12T09:30:00Z" }
    }
  }
}
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

SNAPSHOT_PATH = Path.home() / ".vendavis_vr_snapshots.json"
_lock = threading.Lock()


def _read() -> dict:
    try:
        data = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return {"version": 1, "snapshots": {}}
    if not isinstance(data, dict) or not isinstance(data.get("snapshots"), dict):
        return {"version": 1, "snapshots": {}}
    return data


def _write(data: dict) -> None:
    # Write to a temp file then replace, so a crash can't leave a half-written file.
    tmp = SNAPSHOT_PATH.with_name(SNAPSHOT_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, SNAPSHOT_PATH)


def get_snapshot(alias: str, object_api: str) -> Optional[dict]:
    """Return {"rules": [...], "savedAt": "..."} or None."""
    with _lock:
        snap = _read()["snapshots"].get(alias, {}).get(object_api)
    return snap if isinstance(snap, dict) and snap.get("rules") else None


def save_snapshot(alias: str, object_api: str, rules: list[str]) -> Optional[dict]:
    """Store the rule names for this org/object. An empty list clears the snapshot."""
    names = list(dict.fromkeys(str(r) for r in rules if r))  # de-duplicate, keep order
    with _lock:
        data = _read()
        per_org = data["snapshots"].setdefault(alias, {})
        if not names:
            per_org.pop(object_api, None)
            if not per_org:
                data["snapshots"].pop(alias, None)
            _write(data)
            return None
        per_org[object_api] = {
            "rules":   names,
            "savedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        _write(data)
        return per_org[object_api]
