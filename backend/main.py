"""
sf-metadata-exp — FastAPI backend
Serves all Salesforce, AI, and Excel operations over localhost REST.
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
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn

from sf_cli import SessionExpiredError
from sf_cli import (list_orgs, list_objects, describe_object, run_apex_anonymous,
                    list_profiles, list_permission_sets,
                    get_fls_for_profile, get_object_perms_for_profile,
                    get_fls_for_permset, get_object_perms_for_permset,
                    get_org_limits, get_validation_rules, toggle_validation_rule,
                    sf_rest_request, get_security_settings, get_org_api_version)
from sf_cli import _sf as _sf_raw   # for raw SOQL
import vr_snapshot
from excel_builder import build_excel
from query_history import _qh_save, _qh_load
from ai_client import AIClient, PROVIDER_PRESETS, fetch_models, needs_key, save_config, _load_avio_config as _load_config, _load_api_key, _load_base_url, _load_legacy_config, API_KEY_PATH
from sf_skills import augment_system, get_skills_manifest, fetch_skill
from platform_env import avio_data_dir

app = FastAPI(title="Avio", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # covers tauri://localhost, http://localhost:5173, file://
    allow_origin_regex=r".*",     # catch-all for any WebView origin
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

def _session_expired_response(exc: SessionExpiredError) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"detail": str(exc), "code": "session_expired", "alias": exc.alias},
    )


@app.exception_handler(SessionExpiredError)
async def _on_session_expired(request, exc: SessionExpiredError):
    return _session_expired_response(exc)


@app.exception_handler(StarletteHTTPException)
async def _on_http_exception(request, exc: StarletteHTTPException):
    # Most routes do `except Exception as e: raise HTTPException(500, str(e))`.
    # Python chains the original error as __context__, so an expired Salesforce
    # session is still recognisable here and becomes a 401 with a clear message.
    cause = exc.__context__
    while cause is not None and not isinstance(cause, SessionExpiredError):
        cause = cause.__context__
    if isinstance(cause, SessionExpiredError):
        return _session_expired_response(cause)
    return await http_exception_handler(request, exc)


_ai = AIClient()

# ---------------------------------------------------------------------------
# Settings (API key, model, base URL)
# ---------------------------------------------------------------------------

AVAILABLE_MODELS = [
    # OpenCode gateway (oc_sk_ keys) — ids must be enabled in the Console workspace
    {"id": "claude-haiku-5-5",          "label": "Claude Haiku 5.5  — OpenCode, fastest and cheapest"},
    {"id": "claude-sonnet-5-5",         "label": "Claude Sonnet 5.5 — OpenCode, balanced (recommended)"},
    {"id": "claude-opus-5-5",           "label": "Claude Opus 5.5   — OpenCode, most capable"},
    {"id": "gpt-5.4-mini",              "label": "GPT 5.4 Mini      — OpenCode, low cost"},
    {"id": "deepseek-v4.1-flash",       "label": "DeepSeek V4.1 Flash — OpenCode, low cost"},
    # OpenAI
    {"id": "gpt-4o",                    "label": "GPT-4o          — OpenAI flagship, fast and capable"},
    {"id": "gpt-4o-mini",               "label": "GPT-4o mini     — OpenAI lightweight, low cost"},
    {"id": "o3",                        "label": "o3              — OpenAI reasoning model"},
    # Anthropic (via OpenAI-compat or direct)
    {"id": "claude-sonnet-4-6",         "label": "Claude Sonnet   — efficient for everyday tasks"},
    {"id": "claude-opus-4-6-v1",        "label": "Claude Opus     — most capable for ambitious work"},
    # Meta / open-weight (via gateway)
    {"id": "meta-llama/llama-3.3-70b-instruct", "label": "Llama 3.3 70B  — open-weight via gateway"},
]

class SettingsRequest(BaseModel):
    api_key:         Optional[str]  = None
    model:           Optional[str]  = None
    base_url:        Optional[str]  = None
    theme:           Optional[str]  = None   # "system" | "light" | "dark"
    skills_enabled:  Optional[bool] = None
    skills_source:   Optional[str]  = None   # "bundled" | "path" | "url"
    skills_path:     Optional[str]  = None
    skills_url:      Optional[str]  = None
    custom_skills:   Optional[list] = None   # [{name, path}]

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
    # Surface the effective base_url (avio config takes priority, then legacy)
    effective_url = cfg.get("base_url", "").strip() or legacy.get("base_url", "").strip()
    if not needs_key(effective_url):
        key_set = True   # local servers (Ollama etc.) run without a key
    return {
        "key_set":        key_set,
        "providers":      PROVIDER_PRESETS,
        "model":          cfg.get("model", ""),
        "base_url":       effective_url,
        "models":         AVAILABLE_MODELS,
        "key_source":     "avio" if API_KEY_PATH.exists() else
                          ("legacy" if legacy.get("api_key") else "none"),
        # Theme
        "theme":          cfg.get("theme", "system"),
        # Skills config
        "skills_enabled": cfg.get("skills_enabled", True),
        "skills_source":  cfg.get("skills_source",  "bundled"),
        "skills_path":    cfg.get("skills_path",    ""),
        "skills_url":     cfg.get("skills_url",     ""),
        "custom_skills":  cfg.get("custom_skills",  []),
    }

class ModelsRequest(BaseModel):
    api_key:  Optional[str] = None
    base_url: Optional[str] = None

@app.post("/api/models")
def post_models(req: ModelsRequest):
    """Live model list from the configured provider; falls back to the built-in list.

    Accepts unsaved key/base_url from the Settings form so the picker can refresh before saving.
    """
    try:
        ids = fetch_models(req.api_key, req.base_url)
        if not ids:
            raise RuntimeError("provider returned no models")
        return {"source": "live", "models": [{"id": i, "label": i} for i in ids]}
    except Exception as e:
        return {"source": "fallback", "error": str(e)[:300], "models": AVAILABLE_MODELS}

@app.post("/api/settings")
def post_settings(req: SettingsRequest):
    # Persist API key to ~/.avio_api_key
    if req.api_key is not None:
        key_path = API_KEY_PATH
        if req.api_key.strip():
            key_path.write_text(req.api_key.strip())
        # Blank key = don't overwrite existing
    # Persist model + base_url + skills config
    save_config(
        model=req.model or "",
        base_url=req.base_url if req.base_url is not None else "",
        theme=req.theme,
        skills_enabled=req.skills_enabled,
        skills_source=req.skills_source,
        skills_path=req.skills_path,
        skills_url=req.skills_url,
        custom_skills=req.custom_skills,
    )
    # Force the AI client to rebuild with new settings on next call
    _ai._client = None
    return {"ok": True}


class SkillsTestRequest(BaseModel):
    skills_source: Optional[str] = None
    skills_path:   Optional[str] = None
    skills_url:    Optional[str] = None

@app.get("/api/ai/skills")
def get_ai_skills():
    """Returns the skills manifest from saved config."""
    try:
        return get_skills_manifest()
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/ai/skills/test")
def test_ai_skills(req: SkillsTestRequest):
    """
    Test skills availability using the provided draft config values
    (before they are saved). Used by the Settings UI Refresh button.
    """
    try:
        override = {}
        if req.skills_source is not None:
            override["source"] = req.skills_source
        if req.skills_path is not None:
            override["path"] = req.skills_path
        if req.skills_url is not None:
            override["url"] = req.skills_url
        return get_skills_manifest(config_override=override)
    except Exception as e:
        raise HTTPException(500, str(e))


class SkillFetchRequest(BaseModel):
    name:   str
    source: str   # "bundled:<slug>" | "github:<slug>" | "https://..." | "/path/..." | "file://..."

@app.post("/api/ai/skills/fetch")
def fetch_ai_skill(req: SkillFetchRequest):
    """
    Download/copy a skill from the given source into ~/.avio_skills/<name>/.
    Returns {ok, path, files, error}.
    """
    try:
        result = fetch_skill(req.name, req.source)
        if not result["ok"]:
            raise HTTPException(400, result["error"] or "Fetch failed")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class SkillDeleteRequest(BaseModel):
    name: str   # directory name under ~/.avio_skills/

@app.post("/api/ai/skills/remove")   # POST alias: the desktop client only sends GET/POST
@app.delete("/api/ai/skills/fetch")
def delete_ai_skill(req: SkillDeleteRequest):
    """Remove a downloaded skill from the user skills directory."""
    from sf_skills import remove_skill
    try:
        return {"ok": True, "removed": remove_skill(req.name)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Could not remove skill: {e}")


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
                "readable": f.get("filterable", True),
                "editable": not f.get("calculated", False) and not f.get("autoNumber", False),
                # required on create: Salesforce will reject a blank value at save time.
                #   1. nillable=False  - SF enforces non-null at the API level
                #   2. nameField=True  - the primary name field (e.g. Account.Name) is
                #      always required even when SF marks it nillable (e.g. on
                #      PersonAccount-enabled orgs, compound switchablepersonname).
                # Gated on createable so system fields (Id, CreatedDate, ...) are excluded.
                "required": (
                    f.get("createable", False) and (
                        not f.get("nillable", True) or
                        f.get("nameField", False)
                    )
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


class VRSnapshotRequest(BaseModel):
    rules: list[str]   # empty list clears the snapshot


@app.get("/api/orgs/{alias}/objects/{object_api}/validation-rules/snapshot")
def get_vr_snapshot(alias: str, object_api: str):
    """Rules that were active before the last bulk Disable All (survives restarts)."""
    return {"snapshot": vr_snapshot.get_snapshot(alias, object_api)}


@app.post("/api/orgs/{alias}/objects/{object_api}/validation-rules/snapshot")
def save_vr_snapshot(alias: str, object_api: str, body: VRSnapshotRequest):
    try:
        return {"snapshot": vr_snapshot.save_snapshot(alias, object_api, body.rules)}
    except Exception as e:
        raise HTTPException(500, f"Could not save the restore snapshot: {e}")


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

@app.get("/api/orgs/{alias}/api-version")
def org_api_version(alias: str):
    """API version of the org's CLI session (used for generated -meta.xml files)."""
    try:
        return {"apiVersion": get_org_api_version(alias)}
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
        return sf_rest_request(alias, req.method, req.path, req.body)
    except Exception as e:
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# Security settings (Health tab)
# ---------------------------------------------------------------------------

@app.get("/api/orgs/{alias}/security-settings")
def security_settings(alias: str):
    """Retrieve SecuritySettings + NetworkAccess metadata and return a parsed dict."""
    try:
        return get_security_settings(alias)
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
# AI chat — streaming SSE (provider-agnostic via ai_client)
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    messages:    list[dict]
    system:      Optional[str]  = None
    org_context: Optional[dict] = None
    model:       Optional[str]  = None   # override from settings

@app.post("/api/ai/chat")
def ai_chat(req: ChatRequest):
    augmented_system = augment_system(req.system, req.messages)
    def _stream():
        try:
            for chunk in _ai.stream(req.messages, system=augmented_system, model=req.model or None):
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(_stream(), media_type="text/event-stream")

# Keep old path as alias for backwards compatibility during migration
@app.post("/api/claude/chat")
def claude_chat_compat(req: ChatRequest):
    return ai_chat(req)

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


@app.get("/api/sf-version")
def sf_version():
    """Check that the Salesforce CLI is available and return its version."""
    from sf_cli import _find_sf_cli, _augmented_path, SUBPROCESS_KWARGS
    import subprocess, re as _re
    try:
        sf_bin = _find_sf_cli()
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    env = {**os.environ, "PATH": _augmented_path()}
    try:
        result = subprocess.run(
            [sf_bin, "version", "--json"],
            timeout=60, env=env, **SUBPROCESS_KWARGS
        )
        clean = _re.sub(r'\x1b\[[0-9;]*m', '', result.stdout).strip()
        try:
            data = json.loads(clean)
            version_str = data.get("result", {}).get("cliVersion") or data.get("cliVersion") or clean
        except Exception:
            version_str = clean or result.stderr.strip() or "unknown"
        return {"sf_bin": sf_bin, "version": version_str}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="sf version check timed out")

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
