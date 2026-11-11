"""
sf-metadata-exp — FastAPI backend
Serves all Salesforce, Claude, and Excel operations over localhost REST.
Launched as a child process by Tauri; port is passed via SF_BACKEND_PORT env var
or defaults to 7891.
"""
from __future__ import annotations

import os
import json
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

from sf_cli import (list_orgs, list_objects, describe_object, run_apex_anonymous,
                    list_profiles, list_permission_sets,
                    get_fls_for_profile, get_object_perms_for_profile,
                    get_fls_for_permset, get_object_perms_for_permset,
                    get_org_limits, get_validation_rules, toggle_validation_rule,
                    sf_rest_request, get_security_settings)
from sf_cli import _sf as _sf_raw   # for raw SOQL
from excel_builder import build_excel
from query_history import _qh_save, _qh_load
from claude_client import ClaudeClient, save_config, _load_config, _load_api_key, _load_base_url, _load_legacy_config

app = FastAPI(title="Vendavis", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # covers tauri://localhost, http://localhost:5173, file://
    allow_origin_regex=r".*",     # catch-all for any WebView origin
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

_claude  = ClaudeClient()

# ---------------------------------------------------------------------------
# Settings (API key, model, base URL)
# ---------------------------------------------------------------------------

AVAILABLE_MODELS = [
    # Sonnet family
    {"id": "claude-sonnet-4-6",                      "label": "Sonnet 4.6     — most efficient for everyday tasks"},
    {"id": "claude-sonnet-4-6-thinking",              "label": "Sonnet 4.6 1M  — 1M context window"},
    {"id": "claude-sonnet-5-20250929",                "label": "Sonnet 5       — most efficient for everyday tasks"},
    {"id": "claude-sonnet-5-20250929-thinking",       "label": "Sonnet 5 1M    — 1M context window"},
    # Opus family
    {"id": "claude-opus-4-6-v1",                     "label": "Opus 4.6       — most capable for ambitious work"},
    {"id": "claude-opus-4-6-v1-thinking",             "label": "Opus 4.6 1M   — 1M context window"},
    {"id": "claude-opus-4-7",                         "label": "Opus 4.7       — most capable for ambitious work"},
    {"id": "claude-opus-4-7-thinking",                "label": "Opus 4.7 1M   — 1M context window"},
    {"id": "claude-opus-4-8",                         "label": "Opus 4.8       — most capable for ambitious work"},
    {"id": "claude-opus-4-8-thinking",                "label": "Opus 4.8 1M   — 1M context window"},
]

class SettingsRequest(BaseModel):
    api_key:  Optional[str] = None
    model:    Optional[str] = None
    base_url: Optional[str] = None

@app.get("/api/settings")
def get_settings():
    cfg    = _load_config()
    legacy = _load_legacy_config()
    # Mask key: return whether one exists, not the value
    key_set = False
    try:
        _load_api_key()
        key_set = True
    except Exception:
        pass
    # Surface the effective base_url (vendavis config takes priority, then legacy)
    effective_url = cfg.get("base_url", "").strip() or legacy.get("base_url", "").strip()
    return {
        "key_set":       key_set,
        "model":         cfg.get("model", ""),
        "base_url":      effective_url,
        "models":        AVAILABLE_MODELS,
        "key_source":    "vendavis" if (Path.home() / ".anthropic_key").exists() else
                         ("legacy" if legacy.get("api_key") else "none"),
    }

@app.post("/api/settings")
def post_settings(req: SettingsRequest):
    # Persist API key to ~/.anthropic_key
    if req.api_key is not None:
        key_path = Path.home() / ".anthropic_key"
        if req.api_key.strip():
            key_path.write_text(req.api_key.strip())
        # Blank key = don't overwrite existing
    # Persist model + base_url to config
    save_config(
        model=req.model or "",
        base_url=req.base_url if req.base_url is not None else "",
    )
    # Force the Claude client to rebuild with new settings on next call
    _claude._client = None
    return {"ok": True}

# ---------------------------------------------------------------------------
# Orgs
# ---------------------------------------------------------------------------

@app.get("/api/orgs")
def get_orgs():
    try:
        orgs = list_orgs()   # [(alias, username, is_default), ...]
        return {"orgs": [{"alias": a or u, "username": u, "isDefault": d} for a, u, d in orgs]}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# Objects
# ---------------------------------------------------------------------------

@app.get("/api/orgs/{alias}/objects")
def get_objects(alias: str):
    try:
        pairs = list_objects(alias)   # [(api_name, label), ...]
        return {"objects": [{"apiName": a, "label": l} for a, l in pairs]}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# Fields
# ---------------------------------------------------------------------------

@app.get("/api/orgs/{alias}/objects/{object_api}/fields")
def get_fields(alias: str, object_api: str):
    try:
        describe = describe_object(alias, object_api)
        raw_fields = describe.get("fields", [])
        fields = [
            {
                "apiName":  f.get("name", ""),
                "label":    f.get("label", ""),
                "type":     f.get("type", ""),
                # readable = the running user can read this field (accessible)
                "readable": f.get("accessible", True),
                # editable = the running user can write this field
                "editable": f.get("updateable", False) or f.get("createable", False),
                # required on create: field must be supplied when creating a record
                # (createable=True AND nillable=False AND not system-defaulted on insert)
                "required": (
                    f.get("createable", False) and
                    not f.get("nillable", True) and
                    not f.get("defaultedOnCreate", False)
                ),
            }
            for f in raw_fields
        ]
        return {"fields": fields}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/orgs/{alias}/objects/{object_api}/validation-rules")
def get_vr(alias: str, object_api: str):
    try:
        rules = get_validation_rules(alias, object_api)
        return {"rules": rules}
    except Exception as e:
        raise HTTPException(500, str(e))


class ToggleVRRequest(BaseModel):
    rule_name: str
    active: bool


@app.post("/api/orgs/{alias}/objects/{object_api}/validation-rules/toggle")
def toggle_vr(alias: str, object_api: str, body: ToggleVRRequest):
    try:
        toggle_validation_rule(alias, object_api, body.rule_name, body.active)
        return {"ok": True, "active": body.active}
    except Exception as e:
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# REST Explorer proxy
# ---------------------------------------------------------------------------

class RestProxyRequest(BaseModel):
    method: str = "GET"
    path:   str
    body:   Optional[str] = None   # JSON string, only for POST/PUT/PATCH


@app.post("/api/orgs/{alias}/rest")
def rest_proxy(alias: str, req: RestProxyRequest):
    try:
        result = sf_rest_request(alias, req.method, req.path, req.body)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/orgs/{alias}/security-settings")
def security_settings(alias: str):
    """Retrieve SecuritySettings + NetworkAccess metadata and return parsed dict."""
    try:
        return get_security_settings(alias)
    except Exception as e:
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# Profiles & Permission Sets
# ---------------------------------------------------------------------------

@app.get("/api/orgs/{alias}/profiles")
def get_profiles(alias: str):
    try:
        names = list_profiles(alias)
        return {"profiles": names}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/orgs/{alias}/permsets")
def get_permsets(alias: str):
    try:
        names = list_permission_sets(alias)
        return {"permsets": names}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/orgs/{alias}/profiles/{profile_name}/objects/{object_api}/fls")
def get_profile_fls(alias: str, profile_name: str, object_api: str):
    try:
        obj_perms = get_object_perms_for_profile(alias, profile_name, object_api)
        fls       = get_fls_for_profile(alias, profile_name, object_api)
        return {"obj_perms": obj_perms, "fls": fls}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/orgs/{alias}/permsets/{permset_name}/objects/{object_api}/fls")
def get_permset_fls(alias: str, permset_name: str, object_api: str):
    try:
        obj_perms = get_object_perms_for_permset(alias, permset_name, object_api)
        fls       = get_fls_for_permset(alias, permset_name, object_api)
        return {"obj_perms": obj_perms, "fls": fls}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# Org limits
# ---------------------------------------------------------------------------

@app.get("/api/orgs/{alias}/limits")
def org_limits(alias: str):
    try:
        limits = get_org_limits(alias)
        # Pull out the most important ones for the status bar
        daily = limits.get("DailyApiRequests", {})
        return {
            "limits": limits,
            "dailyApiRequests": {
                "used":  daily.get("Max", 0) - daily.get("Remaining", 0),
                "max":   daily.get("Max", 0),
            },
        }
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# SOQL
# ---------------------------------------------------------------------------

class SoqlRequest(BaseModel):
    alias: str
    query: str

@app.post("/api/soql")
def run_soql_query(req: SoqlRequest):
    try:
        data    = _sf_raw("data", "query", "--query", req.query, "--target-org", req.alias)
        records = data.get("result", {}).get("records", [])
        # Strip Salesforce attributes wrapper
        clean = [{k: v for k, v in r.items() if k != "attributes"} for r in records]
        _qh_save(req.alias, req.query, len(clean))
        return {"records": clean, "totalSize": len(clean)}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/soql/history")
def get_soql_history(limit: int = 50):
    rows = _qh_load(limit=limit)
    return {"history": [r["soql"] for r in rows]}

# ---------------------------------------------------------------------------
# Apex
# ---------------------------------------------------------------------------

class ApexRequest(BaseModel):
    alias:     str
    code:      str
    log_level: Optional[str] = "DEBUG"

@app.post("/api/apex")
def execute_apex(req: ApexRequest):
    try:
        success, logs, error = run_apex_anonymous(req.alias, req.code, req.log_level or "DEBUG")
        return {"output": logs or "", "success": success, "error": error}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# FLS / Object Permissions export
# ---------------------------------------------------------------------------

class ExportRequest(BaseModel):
    alias: str
    objects: list[str]
    output_dir: Optional[str] = None

@app.post("/api/export")
def export_fls(req: ExportRequest):
    try:
        from sf_cli import describe_object
        out_dir = Path(req.output_dir) if req.output_dir else Path.home() / "Downloads"
        out_dir.mkdir(parents=True, exist_ok=True)

        # Field inventory only — no profile/permset queries
        objects_data = {}
        for obj_api in req.objects:
            desc = describe_object(req.alias, obj_api)
            objects_data[obj_api] = {
                "label":           desc.get("label", obj_api),
                "fields":          desc.get("fields", []),
                "recordTypeInfos": desc.get("recordTypeInfos", []),
                "profiles":        {},
                "permsets":        {},
            }

        base_path = str(out_dir / "sf_fls_export.xlsx")
        paths = build_excel(base_path, objects_data, [], [],
                            target_org=req.alias)
        return {"files": paths}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# Principal FLS export (Profiles & PermSets tab)
# ---------------------------------------------------------------------------

class PrincipalExportRequest(BaseModel):
    alias:          str
    principal_type: str         # "profile" | "permset"
    principal_name: str
    objects:        Optional[list[str]] = None   # if provided, export only these objects
    output_dir:     Optional[str] = None

# ---------------------------------------------------------------------------
# In-process cache for principal FLS data (avoids re-running Query 1)
# ---------------------------------------------------------------------------

_principal_cache: dict = {}   # (alias, type, name) → {"data": ..., "ts": float}
CACHE_TTL = 300               # seconds (5 minutes)

def _cache_get(alias, ptype, pname):
    key = (alias, ptype, pname)
    entry = _principal_cache.get(key)
    if entry and (time.time() - entry["ts"]) < CACHE_TTL:
        return entry["data"]
    return None

def _cache_set(alias, ptype, pname, data):
    _principal_cache[(alias, ptype, pname)] = {"data": data, "ts": time.time()}


@app.post("/api/export/principal")
def export_principal_fls(req: PrincipalExportRequest):
    """SSE-streaming export — pushes progress events then a final {files} event."""
    from sf_cli import get_all_fls_for_principal, get_field_metadata_bulk

    def _stream():
        try:
            out_dir = Path(req.output_dir) if req.output_dir else Path.home() / "Downloads"
            out_dir.mkdir(parents=True, exist_ok=True)
            t0 = time.time()

            # Step 1 — bulk FLS + object perms (cache-aware)
            scoped = req.objects  # None means "all objects the principal has access to"
            cached = _cache_get(req.alias, req.principal_type, req.principal_name)
            if cached is not None:
                principal_data = cached
                yield f"data: {json.dumps({'status': 'Query 1 of 3 — loaded from cache ⚡'})}\n\n"
            else:
                scope_label = f"{len(scoped)} selected object(s)" if scoped else "all objects"
                yield f"data: {json.dumps({'status': f'Query 1 of 3 — fetching field permissions for {scope_label}…'})}\n\n"
                principal_data = get_all_fls_for_principal(
                    req.alias, req.principal_type, req.principal_name
                )
                _cache_set(req.alias, req.principal_type, req.principal_name, principal_data)
            # Filter to only the requested objects if a list was provided
            if scoped:
                scoped_set = set(scoped)
                principal_data = {k: v for k, v in principal_data.items() if k in scoped_set}
            obj_names = list(principal_data.keys())
            yield f"data: {json.dumps({'status': f'Query 1 of 3 complete — {len(obj_names)} objects ({time.time()-t0:.0f}s)'})}\n\n"

            # Step 2 — bulk field metadata
            t1 = time.time()
            yield f"data: {json.dumps({'status': f'Query 2 of 3 — fetching field metadata for {len(obj_names)} objects…'})}\n\n"
            field_meta = get_field_metadata_bulk(req.alias, obj_names)
            total_fields = sum(len(v) for v in field_meta.values())
            yield f"data: {json.dumps({'status': f'Query 2 of 3 complete — {total_fields} fields ({time.time()-t1:.0f}s)'})}\n\n"

            # Step 3 — object labels
            t2 = time.time()
            yield f"data: {json.dumps({'status': 'Query 3 of 3 — fetching object labels…'})}\n\n"
            obj_labels = {}
            if obj_names:
                # Batch in groups of 200 (EntityDefinition supports it)
                from sf_cli import _sf as _sf_raw2
                for i in range(0, len(obj_names), 200):
                    batch = obj_names[i:i+200]
                    in_clause = ", ".join(f"'{o}'" for o in batch)
                    try:
                        ldata = _sf_raw2("data", "query",
                            "--query", f"SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName IN ({in_clause})",
                            "--target-org", req.alias)
                        for r in ldata.get("result", {}).get("records", []):
                            obj_labels[r["QualifiedApiName"]] = r["Label"]
                    except Exception:
                        pass
            yield f"data: {json.dumps({'status': f'Query 3 of 3 complete ({time.time()-t2:.0f}s)'})}\n\n"

            # Step 4 — build + write Excel
            yield f"data: {json.dumps({'status': 'Building Excel workbook…'})}\n\n"
            t3 = time.time()
            objects_data = {}
            for obj_api, pdata in principal_data.items():
                fmeta  = field_meta.get(obj_api, {})
                fields = [
                    {"name": fname, "label": fm["label"], "type": fm["type"],
                     "filterable": True, "calculated": False, "autoNumber": False}
                    for fname, fm in fmeta.items()
                ]
                objects_data[obj_api] = {
                    "label":           obj_labels.get(obj_api, obj_api),
                    "fields":          fields,
                    "recordTypeInfos": [],
                    "profiles":        {req.principal_name: pdata} if req.principal_type == "profile" else {},
                    "permsets":        {req.principal_name: pdata} if req.principal_type == "permset" else {},
                }

            profiles = [req.principal_name] if req.principal_type == "profile" else []
            permsets = [req.principal_name] if req.principal_type == "permset" else []
            safe_name = "".join(c if c.isalnum() or c in "_-" else "_" for c in req.principal_name)
            base_path = str(out_dir / f"sf_fls_{safe_name}.xlsx")
            paths = build_excel(base_path, objects_data, profiles, permsets, target_org=req.alias)

            total = time.time() - t0
            yield f"data: {json.dumps({'status': f'Done in {total:.0f}s', 'files': paths})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")

# ---------------------------------------------------------------------------
# Claude chat — streaming SSE
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    messages:    list[dict]
    system:      Optional[str]  = None
    org_context: Optional[dict] = None
    model:       Optional[str]  = None   # override from settings

@app.post("/api/claude/chat")
def claude_chat(req: ChatRequest):
    def _stream():
        try:
            for chunk in _claude.stream(req.messages, system=req.system, model=req.model or None):
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(_stream(), media_type="text/event-stream")

# ---------------------------------------------------------------------------
# Open file via OS default app (fallback when Tauri invoke unavailable)
# ---------------------------------------------------------------------------

class OpenFileRequest(BaseModel):
    path: str

@app.post("/api/open_file")
def open_file(req: OpenFileRequest):
    import subprocess, sys
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", req.path])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", req.path])
        else:
            subprocess.Popen(["xdg-open", req.path])
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, str(e))

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


@app.post("/api/shutdown")
def shutdown():
    """Gracefully shut down the backend. Called by Tauri before app.exit()."""
    import threading, signal
    def _stop():
        import time
        time.sleep(0.1)  # let the HTTP response send first
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_stop, daemon=True).start()
    return {"status": "shutting down"}


@app.get("/api/debug-env")
def debug_env():
    """Diagnostic endpoint — returns PATH, sf/node locations, and whether each is found."""
    from platform_env import get_platform
    import shutil
    plat = get_platform()
    augmented = plat.augmented_path()
    sf_found   = shutil.which("sf",   path=augmented) or shutil.which("sfdx", path=augmented)
    node_found = shutil.which("node", path=augmented)
    npm_found  = shutil.which("npm",  path=augmented)
    candidates = plat.sf_cli_candidates()
    candidate_exists = {c: os.path.exists(c) for c in candidates}
    # For MacOS provider, expose the resolved node/npm dirs
    node_dir    = getattr(plat, "_node_bin_dir",    lambda: None)()
    npm_bin_dir = getattr(plat, "_npm_global_bin",  lambda: None)()
    return {
        "platform": plat.__class__.__name__,
        "process_path": os.environ.get("PATH", ""),
        "augmented_path_dirs": augmented.split(os.pathsep),
        "sf_found":   sf_found,
        "node_found": node_found,
        "npm_found":  npm_found,
        "node_bin_dir_probe":   node_dir,
        "npm_global_bin_probe": npm_bin_dir,
        "sf_candidates": candidate_exists,
    }


@app.get("/api/sf-version")
def sf_version():
    """Check that the Salesforce CLI is available and return its version."""
    from sf_cli import _find_sf_cli, _augmented_path
    import subprocess, re as _re
    try:
        sf_bin = _find_sf_cli()
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    env = {**os.environ, "PATH": _augmented_path()}
    try:
        result = subprocess.run(
            [sf_bin, "version", "--json"],
            capture_output=True, text=True, timeout=15, env=env
        )
        clean = _re.sub(r'\x1b\[[0-9;]*m', '', result.stdout).strip()
        try:
            data = json.loads(clean)
            version_str = data.get("result", {}).get("cliVersion") or data.get("cliVersion") or clean
        except Exception:
            version_str = clean or result.stderr.strip() or "unknown"
        return {"sf_bin": sf_bin, "version": version_str}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=503, detail="sf version check timed out")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import socket
    desired = int(os.environ.get("SF_BACKEND_PORT", 7891))

    def _port_free(p):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("127.0.0.1", p)) != 0

    port = desired if _port_free(desired) else 0  # 0 = OS picks a free port
    if port != desired:
        print(f"[backend] port {desired} in use, letting OS assign a free port")

    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
