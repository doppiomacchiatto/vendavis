"""
sf_cli.py — Salesforce CLI wrappers for sf_fls_exporter.

All functions here are pure (no UI), thread-safe, and importable independently.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from platform_env import get_platform

SF_CLI = None   # resolved lazily on first call

DEBUG = os.environ.get("VENDAVIS_DEBUG", "").lower() in ("1", "true", "yes")


def _debug(msg: str) -> None:
    if DEBUG:
        print(f"[sf_cli] {msg}", flush=True)

# Windows: don't flash a console window per sf call; always decode as UTF-8
# (text=True alone uses the ANSI code page there). Harmless on other OSes.
SUBPROCESS_KWARGS = {
    "capture_output": True,
    "text": True,
    "encoding": "utf-8",
    "errors": "replace",
    "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
}


class SessionExpiredError(RuntimeError):
    """The org's stored session/refresh token is no longer valid."""

    def __init__(self, alias: str | None = None):
        self.alias = alias
        target = f"org '{alias}'" if alias else "this org"
        login = f"sf org login web --alias {alias}" if alias else "sf org login web"
        super().__init__(
            f"The Salesforce session for {target} has expired or been revoked. "
            f"Re-authenticate by running:  {login}"
        )


_SESSION_EXPIRED_RE = re.compile(
    r"expired access/refresh token|invalid_grant|INVALID_SESSION_ID|"
    r"Session expired or invalid|Unable to refresh session|"
    r"authenticating with the refresh token",
    re.IGNORECASE,
)


def _is_session_expired(text: str) -> bool:
    return bool(text and _SESSION_EXPIRED_RE.search(text))


def _org_from_args(args) -> str | None:
    """Pull the target org alias out of sf CLI args, if one was given."""
    args = list(args)
    for i, a in enumerate(args):
        if a in ("--target-org", "-o", "-u", "--target-dev-hub", "-v") and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--target-org="):
            return a.split("=", 1)[1]
    return None


def _augmented_path() -> str:
    """Return an augmented PATH string for the current OS via platform_env."""
    return get_platform().augmented_path()


def _find_sf_cli():
    """
    Locate the sf (or sfdx) binary using the OS-specific PlatformProvider.
    Raises FileNotFoundError if neither can be found.
    """
    result = get_platform().find_tool("sf", "sfdx")
    if result:
        return result
    raise FileNotFoundError(
        "Could not find 'sf' or 'sfdx'. "
        "Install from https://developer.salesforce.com/tools/salesforcecli "
        "and ensure it is on your PATH."
    )


def _sf(*args, timeout=120, cwd=None):
    """Run an sf/sfdx command and return parsed JSON output.

    cwd: directory to run in (needed for commands that require an sfdx-project.json).
    """
    global SF_CLI
    if SF_CLI is None:
        SF_CLI = _find_sf_cli()

    cmd = [SF_CLI, *args, "--json"]
    env = {**os.environ, "PATH": _augmented_path()}
    t0 = time.time()
    result = subprocess.run(cmd, timeout=timeout, env=env, cwd=cwd, **SUBPROCESS_KWARGS)
    _debug(f"sf {' '.join(args)[:200]} -> rc={result.returncode} ({time.time()-t0:.1f}s)")

    import re as _re
    # Strip ANSI color codes before parsing
    clean = _re.sub(r'\x1b\[[0-9;]*m', '', result.stdout).strip()

    # Always try to parse stdout as JSON first — the SF CLI returns rc=2 for
    # warnings (e.g. "update available") even when the command succeeded and
    # stdout contains valid JSON output.
    try:
        data = json.loads(clean)
    except json.JSONDecodeError:
        data = None

    if isinstance(data, dict) and data.get("status") not in (0, None):
        if _is_session_expired(f"{data.get('name', '')} {data.get('message', '')}"):
            raise SessionExpiredError(_org_from_args(args))
    if data is not None:
        return data

    if _is_session_expired(f"{clean}\n{result.stderr}"):
        raise SessionExpiredError(_org_from_args(args))

    # Only treat non-zero rc as an error if stdout wasn't valid JSON
    if result.returncode not in (0, 1):
        raise RuntimeError(
            f"CLI error (rc={result.returncode}):\n{result.stderr or clean}"
        )
    raise RuntimeError(f"Unexpected output:\n{clean[:500]}")


def get_org_limits(target_org: str) -> dict:
    """Fetch API usage limits from the Salesforce REST API.

    Uses `sf org display` to get the access token + instance URL, then
    calls /services/data/vXX.0/limits and reads Sforce-Limit-Info header.

    Returns a dict with at minimum:
      {
        "DailyApiRequests": {"Max": 441450, "Remaining": 440332},
        ... (all limits from /limits endpoint)
      }
    """
    import urllib.request
    import urllib.error

    # Get instance URL and API version from sf org display
    info = _sf("org", "display", "--target-org", target_org)
    result = info.get("result", {})
    instance_url = result.get("instanceUrl") or result.get("instance_url") or ""
    api_version  = result.get("apiVersion") or result.get("api_version") or "68.0"

    def _fetch() -> dict:
        # sf org display redacts the token — use the dedicated command
        token_info   = _sf("org", "auth", "show-access-token", "--target-org", target_org)
        token_result = token_info.get("result", {})
        access_token = token_result.get("accessToken") or token_result.get("access_token")

        if not access_token or not instance_url:
            raise RuntimeError(
                f"Could not retrieve access token or instance URL. "
                f"Token result keys: {list(token_result.keys())}"
            )

        req = urllib.request.Request(
            f"{instance_url}/services/data/v{api_version}/limits",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        return _fetch()
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        if e.code != 401 and not _is_session_expired(body):
            raise RuntimeError(f"Limits API error {e.code}: {body[:200]}")

    # 401: the stored access token has expired. Any normal CLI API call makes
    # sf use the refresh token to get a new one; if that fails it raises
    # SessionExpiredError, which the API layer reports as "log in again".
    _sf("data", "query", "--target-org", target_org,
        "--query", "SELECT Id FROM Organization LIMIT 1")
    try:
        return _fetch()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise SessionExpiredError(target_org)
        raise RuntimeError(f"Limits API error {e.code}: {e.read().decode(errors='replace')[:200]}")


def list_orgs():
    """Return list of (alias, username, is_default) tuples."""
    data = _sf("org", "list")
    orgs = []
    result = data.get("result", {})

    # SF CLI v2 uses different section names depending on version/context.
    # Iterate every value that is a list to catch all of them.
    known_sections = (
        "scratchOrgs", "nonScratchOrgs", "regularOrgs",
        "sandboxOrgs", "other", "devHubs",
    )
    seen_sections = set(known_sections) | set(result.keys())
    for section in seen_sections:
        val = result.get(section, [])
        if not isinstance(val, list):
            continue
        for o in val:
            if not isinstance(o, dict):
                continue
            alias    = o.get("alias") or ""
            username = o.get("username") or ""
            default  = (
                o.get("isDefaultDevHubUsername") or
                o.get("isDefault") or
                o.get("isDefaultUsername") or
                False
            )
            if username:
                orgs.append((alias, username, bool(default)))

    seen, unique = set(), []
    for a, u, d in orgs:
        if u not in seen:
            seen.add(u)
            unique.append((a, u, d))
    return unique


_API_VERSION_CACHE: dict = {}


def get_org_api_version(target_org: str) -> str:
    """API version the CLI session for this org uses (e.g. "68.0"). Cached per alias,
    since `sf org display` costs several seconds."""
    if target_org in _API_VERSION_CACHE:
        return _API_VERSION_CACHE[target_org]
    info = _sf("org", "display", "--target-org", target_org).get("result", {})
    ver = info.get("apiVersion") or info.get("api_version")
    if not ver:
        raise RuntimeError(f"Could not determine the API version for '{target_org}'")
    _API_VERSION_CACHE[target_org] = str(ver)
    return str(ver)


def _rest_get(target_org: str, path: str, timeout: int = 60):
    """GET a REST path (e.g. '/sobjects') under /services/data/vXX.0 using the CLI's auth."""
    import urllib.request
    import urllib.error

    info = _sf("org", "display", "--target-org", target_org).get("result", {})
    instance_url = info.get("instanceUrl") or ""
    api_version = info.get("apiVersion") or "68.0"

    def _fetch():
        tok = _sf("org", "auth", "show-access-token", "--target-org", target_org).get("result", {})
        access_token = tok.get("accessToken") or tok.get("access_token")
        if not access_token or not instance_url:
            raise RuntimeError("Could not retrieve access token or instance URL")
        req = urllib.request.Request(
            f"{instance_url}/services/data/v{api_version}{path}",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        return _fetch()
    except urllib.error.HTTPError as e:
        if e.code != 401:
            raise
    # Expired access token: any CLI API call refreshes it (or raises SessionExpiredError)
    _sf("data", "query", "--target-org", target_org, "--query", "SELECT Id FROM Organization LIMIT 1")
    try:
        return _fetch()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise SessionExpiredError(target_org)
        raise


def list_objects(target_org):
    """Return sorted list of (api_name, label) tuples for all objects.

    Fast path: one REST describe-global call. Falls back to paging
    EntityDefinition via the CLI (one process per 200 rows — slow on big orgs).
    """
    try:
        t0 = time.time()
        data = _rest_get(target_org, "/sobjects")
        pairs = {
            o["name"]: (o.get("label") or o["name"]).strip()
            for o in data.get("sobjects", [])
            if o.get("name") and o.get("retrieveable", True)
        }
        _debug(f"list_objects: {len(pairs)} objects via REST ({time.time()-t0:.1f}s)")
        if pairs:
            return sorted(pairs.items(), key=lambda x: x[1])
    except SessionExpiredError:
        raise
    except Exception as e:
        _debug(f"list_objects: REST path failed ({e!r}), falling back to EntityDefinition paging")

    names = {}
    offset = 0
    batch  = 200   # EntityDefinition supports up to 200 per query

    while True:
        query = (
            "SELECT QualifiedApiName, Label FROM EntityDefinition "
            f"WHERE IsRetrieveable = true "
            f"ORDER BY Label LIMIT {batch} OFFSET {offset}"
        )
        try:
            data    = _sf("data", "query", "--query", query, "--target-org", target_org)
            records = data.get("result", {}).get("records", [])
        except Exception:
            break

        if not records:
            break

        for r in records:
            n = r.get("QualifiedApiName", "")
            l = r.get("Label", n)
            if n:
                names[n] = l

        if len(records) < batch:
            break   # last page
        offset += batch

    return sorted(names.items(), key=lambda x: x[1])   # sorted by label


def describe_object(target_org, obj_name):
    """Return the describe result for a single object."""
    data = _sf("sobject", "describe", "--sobject", obj_name,
               "--target-org", target_org, timeout=60)
    return data.get("result", {})


def list_profiles(target_org):
    data = _sf("data", "query",
               "--query", "SELECT Id, Name FROM Profile ORDER BY Name",
               "--target-org", target_org)
    return [r["Name"] for r in data.get("result", {}).get("records", [])]


def list_permission_sets(target_org):
    data = _sf("data", "query",
               "--query",
               "SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Name",
               "--target-org", target_org)
    return [r["Name"] for r in data.get("result", {}).get("records", [])]


def get_all_fls_for_object(target_org, obj_name):
    """Return bulk FLS + object perms for ALL profiles and permsets on one object.

    Makes just 2 SOQL calls total (FieldPermissions + ObjectPermissions),
    then pivots by principal name.

    Returns:
        profiles_data: {profile_name: {"obj_perms": {...}, "fls": {field: {readable, editable}}}}
        permsets_data: {permset_name: {"obj_perms": {...}, "fls": {field: {readable, editable}}}}
    """
    # ── FieldPermissions ────────────────────────────────────────────────────
    fls_query = (
        f"SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile, "
        f"Field, PermissionsRead, PermissionsEdit "
        f"FROM FieldPermissions "
        f"WHERE SobjectType = '{obj_name}'"
    )
    fls_data = _sf("data", "query", "--query", fls_query, "--target-org", target_org)
    fls_records = fls_data.get("result", {}).get("records", [])

    profiles_fls: dict = {}
    permsets_fls: dict = {}
    for r in fls_records:
        field    = r.get("Field", "").split(".")[-1]
        readable = r.get("PermissionsRead", False)
        editable = r.get("PermissionsEdit", False)
        parent   = r.get("Parent") or {}
        owned_by_profile = parent.get("IsOwnedByProfile", False)
        if owned_by_profile:
            pname = (parent.get("Profile") or {}).get("Name") or parent.get("Name", "")
            if pname:
                profiles_fls.setdefault(pname, {})[field] = {"readable": readable, "editable": editable}
        else:
            psname = parent.get("Name", "")
            if psname:
                permsets_fls.setdefault(psname, {})[field] = {"readable": readable, "editable": editable}

    # ── ObjectPermissions ───────────────────────────────────────────────────
    obj_query = (
        f"SELECT Parent.Profile.Name, Parent.Name, Parent.IsOwnedByProfile, "
        f"AllowRead, AllowCreate, AllowEdit, AllowDelete, ViewAllRecords, ModifyAllRecords "
        f"FROM ObjectPermissions "
        f"WHERE SobjectType = '{obj_name}'"
    )
    obj_data = _sf("data", "query", "--query", obj_query, "--target-org", target_org)
    obj_records = obj_data.get("result", {}).get("records", [])

    profiles_obj: dict = {}
    permsets_obj: dict = {}
    for r in obj_records:
        parent = r.get("Parent") or {}
        owned_by_profile = parent.get("IsOwnedByProfile", False)
        perms = {
            "AllowRead":        r.get("AllowRead", False),
            "AllowCreate":      r.get("AllowCreate", False),
            "AllowEdit":        r.get("AllowEdit", False),
            "AllowDelete":      r.get("AllowDelete", False),
            "ViewAllRecords":   r.get("ViewAllRecords", False),
            "ModifyAllRecords": r.get("ModifyAllRecords", False),
        }
        if owned_by_profile:
            pname = (parent.get("Profile") or {}).get("Name") or parent.get("Name", "")
            if pname:
                profiles_obj[pname] = perms
        else:
            psname = parent.get("Name", "")
            if psname:
                permsets_obj[psname] = perms

    # ── Merge ───────────────────────────────────────────────────────────────
    all_profile_names = set(profiles_fls) | set(profiles_obj)
    profiles_data = {
        pn: {
            "obj_perms": profiles_obj.get(pn, {}),
            "fls":       profiles_fls.get(pn, {}),
            "layout_assignments": [],
        }
        for pn in all_profile_names
    }

    all_ps_names = set(permsets_fls) | set(permsets_obj)
    permsets_data = {
        psn: {
            "obj_perms": permsets_obj.get(psn, {}),
            "fls":       permsets_fls.get(psn, {}),
            "layout_assignments": [],
        }
        for psn in all_ps_names
    }

    return profiles_data, permsets_data


def get_field_metadata_bulk(target_org, obj_names):
    """Get field labels + types for a list of objects in bulk via EntityParticle SOQL.

    Returns: {obj_api: {field_api: {label, type}}}
    Pages through in batches of 50 objects to stay under SOQL limits.
    """
    result = {}
    obj_list = list(obj_names)
    batch_size = 50

    for i in range(0, len(obj_list), batch_size):
        batch = obj_list[i:i + batch_size]
        in_clause = ", ".join(f"'{o}'" for o in batch)
        query = (
            f"SELECT EntityDefinition.QualifiedApiName, QualifiedApiName, Label, DataType "
            f"FROM EntityParticle "
            f"WHERE EntityDefinition.QualifiedApiName IN ({in_clause}) "
            f"AND IsLayoutable = true"
        )
        try:
            data    = _sf("data", "query", "--query", query, "--target-org", target_org)
            records = data.get("result", {}).get("records", [])
            for r in records:
                obj   = (r.get("EntityDefinition") or {}).get("QualifiedApiName", "")
                fname = r.get("QualifiedApiName", "")
                if obj and fname:
                    result.setdefault(obj, {})[fname] = {
                        "label": r.get("Label", fname),
                        "type":  r.get("DataType", ""),
                    }
        except Exception:
            continue

    return result


def get_all_fls_for_principal(target_org, principal_type, principal_name):
    """Return ALL FLS + object perms for one profile or permset across ALL objects.

    Makes exactly 2 SOQL calls regardless of how many objects the principal has access to.

    Returns:
        objects_data: {
            obj_api: {
                "obj_perms": {AllowRead, AllowCreate, ...},
                "fls":       {field_name: {readable, editable}},
            }
        }
    """
    if principal_type == "profile":
        parent_filter_fls = f"Parent.Profile.Name = '{principal_name}' AND Parent.IsOwnedByProfile = true"
        parent_filter_obj = f"Parent.Profile.Name = '{principal_name}' AND Parent.IsOwnedByProfile = true"
    else:
        parent_filter_fls = f"Parent.Name = '{principal_name}' AND Parent.IsOwnedByProfile = false"
        parent_filter_obj = f"Parent.Name = '{principal_name}' AND Parent.IsOwnedByProfile = false"

    # ── Bulk FieldPermissions ────────────────────────────────────────────────
    fls_query = (
        f"SELECT SobjectType, Field, PermissionsRead, PermissionsEdit "
        f"FROM FieldPermissions "
        f"WHERE {parent_filter_fls}"
    )
    fls_data    = _sf("data", "query", "--query", fls_query, "--target-org", target_org)
    fls_records = fls_data.get("result", {}).get("records", [])

    fls_by_obj: dict = {}
    for r in fls_records:
        obj   = r.get("SobjectType", "")
        field = r.get("Field", "").split(".")[-1]
        fls_by_obj.setdefault(obj, {})[field] = {
            "readable": r.get("PermissionsRead", False),
            "editable": r.get("PermissionsEdit", False),
        }

    # ── Bulk ObjectPermissions ───────────────────────────────────────────────
    obj_query = (
        f"SELECT SobjectType, AllowRead, AllowCreate, AllowEdit, "
        f"AllowDelete, ViewAllRecords, ModifyAllRecords "
        f"FROM ObjectPermissions "
        f"WHERE {parent_filter_obj}"
    )
    obj_data    = _sf("data", "query", "--query", obj_query, "--target-org", target_org)
    obj_records = obj_data.get("result", {}).get("records", [])

    obj_perms_by_obj: dict = {}
    for r in obj_records:
        obj = r.get("SobjectType", "")
        obj_perms_by_obj[obj] = {
            "AllowRead":        r.get("AllowRead", False),
            "AllowCreate":      r.get("AllowCreate", False),
            "AllowEdit":        r.get("AllowEdit", False),
            "AllowDelete":      r.get("AllowDelete", False),
            "ViewAllRecords":   r.get("ViewAllRecords", False),
            "ModifyAllRecords": r.get("ModifyAllRecords", False),
        }

    # ── Merge by object ──────────────────────────────────────────────────────
    all_objs = set(fls_by_obj) | set(obj_perms_by_obj)
    return {
        obj: {
            "obj_perms": obj_perms_by_obj.get(obj, {}),
            "fls":       fls_by_obj.get(obj, {}),
        }
        for obj in all_objs
    }


def get_object_perms_for_profile(target_org, profile_name, obj_name):
    query = (
        f"SELECT AllowRead, AllowCreate, AllowEdit, AllowDelete, "
        f"ViewAllRecords, ModifyAllRecords "
        f"FROM ObjectPermissions "
        f"WHERE Parent.Profile.Name = '{profile_name}' "
        f"AND SobjectType = '{obj_name}'"
    )
    data    = _sf("data", "query", "--query", query, "--target-org", target_org)
    records = data.get("result", {}).get("records", [])
    return records[0] if records else {}


def get_fls_for_profile(target_org, profile_name, obj_name):
    query = (
        f"SELECT Field, PermissionsRead, PermissionsEdit "
        f"FROM FieldPermissions "
        f"WHERE Parent.Profile.Name = '{profile_name}' "
        f"AND SobjectType = '{obj_name}'"
    )
    data    = _sf("data", "query", "--query", query, "--target-org", target_org)
    records = data.get("result", {}).get("records", [])
    result  = {}
    for r in records:
        field = r.get("Field", "").split(".")[-1]
        result[field] = {
            "readable": r.get("PermissionsRead", False),
            "editable": r.get("PermissionsEdit", False),
        }
    return result


def get_object_perms_for_permset(target_org, permset_name, obj_name):
    query = (
        f"SELECT AllowRead, AllowCreate, AllowEdit, AllowDelete, "
        f"ViewAllRecords, ModifyAllRecords "
        f"FROM ObjectPermissions "
        f"WHERE Parent.Name = '{permset_name}' "
        f"AND Parent.IsOwnedByProfile = false "
        f"AND SobjectType = '{obj_name}'"
    )
    data    = _sf("data", "query", "--query", query, "--target-org", target_org)
    records = data.get("result", {}).get("records", [])
    return records[0] if records else {}


def get_fls_for_permset(target_org, permset_name, obj_name):
    query = (
        f"SELECT Field, PermissionsRead, PermissionsEdit "
        f"FROM FieldPermissions "
        f"WHERE Parent.Name = '{permset_name}' "
        f"AND Parent.IsOwnedByProfile = false "
        f"AND SobjectType = '{obj_name}'"
    )
    data    = _sf("data", "query", "--query", query, "--target-org", target_org)
    records = data.get("result", {}).get("records", [])
    result  = {}
    for r in records:
        field = r.get("Field", "").split(".")[-1]
        result[field] = {
            "readable": r.get("PermissionsRead", False),
            "editable": r.get("PermissionsEdit", False),
        }
    return result


def get_profile_layout_assignments(target_org, profile_name, obj_name):
    """Return list of record-type/page-layout assignments for a profile on an object.

    Returns list of dicts:
        {
          "record_type_name": str,
          "page_layout":      str,
          "is_assigned":      bool,
          "is_default":       bool,
        }
    """
    query = (
        f"SELECT RecordType.Name, Layout.Name, "
        f"RecordTypeId, LayoutId, IsDefault "
        f"FROM ProfileLayout "
        f"WHERE Profile.Name = '{profile_name}' "
        f"AND EntityDefinition.QualifiedApiName = '{obj_name}'"
    )
    try:
        data    = _sf("data", "query", "--query", query, "--target-org", target_org)
        records = data.get("result", {}).get("records", [])
        result  = []
        for r in records:
            rt_id   = r.get("RecordTypeId")
            rt_name = (r.get("RecordType") or {}).get("Name") or "--Master--"
            layout  = (r.get("Layout") or {}).get("Name") or "—"
            is_master = (rt_id is None) or (rt_name == "--Master--")
            result.append({
                "record_type_name": rt_name,
                "page_layout":      layout,
                "is_assigned":      not is_master,
                "is_default":       bool(r.get("IsDefault", False)),
            })
        return sorted(result, key=lambda x: (x["record_type_name"] != "--Master--",
                                              x["record_type_name"]))
    except Exception:
        return _get_record_types_fallback(target_org, obj_name)


def run_apex_anonymous(target_org, apex_code, log_level="DEBUG"):
    """Execute anonymous Apex and return (success, logs, error_message).

    Writes the code to a temp file and uses:
        sf apex run --file <tmpfile> --target-org <org>

    log_level is accepted for API compatibility but the SF CLI controls
    the actual log level via the org's active trace flag.

    Returns:
        (success: bool, logs: str, error: str)
    """
    with tempfile.NamedTemporaryFile(mode="w", suffix=".apex",
                                     delete=False, encoding="utf-8") as f:
        f.write(apex_code)
        tmp_path = f.name

    try:
        result = _sf("apex", "run", "--file", tmp_path,
                     "--target-org", target_org,
                     timeout=120)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    res     = result.get("result", {})
    success  = bool(res.get("success", False))
    compiled = bool(res.get("compiled", True))
    logs     = res.get("logs", "") or ""
    compile_problem = res.get("compileProblem") or ""
    exception_msg   = res.get("exceptionMessage") or ""
    exception_stack = res.get("exceptionStackTrace") or ""

    if not compiled:
        error = f"Compile error: {compile_problem}"
    elif not success:
        error = f"{exception_msg}\n{exception_stack}".strip()
    else:
        error = ""

    return success, logs, error


def _get_record_types_fallback(target_org, obj_name):
    """Fallback: list record types without profile-specific layout/assignment info."""
    query = (
        f"SELECT Name, IsActive FROM RecordType "
        f"WHERE SobjectType = '{obj_name}' AND IsActive = true ORDER BY Name"
    )
    try:
        data    = _sf("data", "query", "--query", query, "--target-org", target_org)
        records = data.get("result", {}).get("records", [])
        result  = [{"record_type_name": "--Master--", "page_layout": "—",
                    "is_assigned": False, "is_default": False}]
        for r in records:
            result.append({
                "record_type_name": r.get("Name", ""),
                "page_layout":      "—",
                "is_assigned":      False,
                "is_default":       False,
            })
        return result
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Validation Rules
# ---------------------------------------------------------------------------

def _get_auth(target_org: str):
    """Return (instance_url, api_version, access_token) for direct REST calls."""
    import urllib.request, urllib.error  # noqa: F401 (used by callers)
    info   = _sf("org", "display", "--target-org", target_org)
    result = info.get("result", {})
    instance_url = result.get("instanceUrl") or result.get("instance_url") or ""
    api_version  = result.get("apiVersion")  or result.get("api_version")  or "68.0"
    token_info   = _sf("org", "auth", "show-access-token", "--target-org", target_org)
    access_token = (token_info.get("result") or {}).get("accessToken") or \
                   (token_info.get("result") or {}).get("access_token")
    if not access_token or not instance_url:
        raise RuntimeError("Could not retrieve access token or instance URL.")
    return instance_url, api_version, access_token


def _soql_quote(value: str) -> str:
    """Escape a value for use inside a single-quoted SOQL string literal."""
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def _tooling_request(instance_url: str, access_token: str, method: str, path: str,
                     body=None, timeout: int = 30):
    """Tooling API call. Returns parsed JSON (None for an empty 204 response).

    Raises RuntimeError with Salesforce's error text on any HTTP error.
    """
    import urllib.request, urllib.error

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{instance_url}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {access_token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Tooling API error {e.code}: {e.read().decode('utf-8', 'replace')[:500]}")
    return json.loads(raw) if raw else None


def _vr_query(instance_url: str, api_version: str, access_token: str,
              object_api: str, rule_name: str | None = None) -> list:
    """List ValidationRule rows for an object (optionally one rule by name).

    The formula is NOT a queryable column; it only exists in the record's Metadata.
    """
    import urllib.parse
    soql = (
        "SELECT Id, Active, ValidationName, ErrorDisplayField, ErrorMessage, Description "
        f"FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '{_soql_quote(object_api)}' "
    )
    if rule_name:
        soql += f"AND ValidationName = '{_soql_quote(rule_name)}' "
    soql += "ORDER BY ValidationName"
    data = _tooling_request(
        instance_url, access_token, "GET",
        f"/services/data/v{api_version}/tooling/query?q={urllib.parse.quote(soql)}",
        timeout=20,
    )
    return (data or {}).get("records", [])


def get_validation_rules(target_org: str, object_api: str) -> list:
    """Fetch all validation rules for an object via the Tooling API.

    Returns a list of dicts:
      { id, name, active, errorField, errorConditionFormula, errorMessage, description }
    """
    from concurrent.futures import ThreadPoolExecutor

    instance_url, api_version, access_token = _get_auth(target_org)
    records = _vr_query(instance_url, api_version, access_token, object_api)

    def formula_for(rec_id: str) -> str:
        try:
            full = _tooling_request(
                instance_url, access_token, "GET",
                f"/services/data/v{api_version}/tooling/sobjects/ValidationRule/{rec_id}",
            )
            return ((full or {}).get("Metadata") or {}).get("errorConditionFormula") or ""
        except Exception:
            return ""

    with ThreadPoolExecutor(max_workers=8) as pool:
        formulas = list(pool.map(lambda r: formula_for(r.get("Id", "")), records))

    return [
        {
            "id":                    r.get("Id", ""),
            "name":                  r.get("ValidationName", ""),
            "active":                r.get("Active", False),
            "errorField":            r.get("ErrorDisplayField") or "",
            "errorConditionFormula": formula,
            "errorMessage":          r.get("ErrorMessage") or "",
            "description":           r.get("Description") or "",
        }
        for r, formula in zip(records, formulas)
    ]


def toggle_validation_rule(target_org: str, object_api: str, rule_name: str, active: bool) -> None:
    """Enable or disable a validation rule, changing ONLY its `active` flag.

    Reads the rule's full current definition (the Tooling API record's Metadata),
    flips `active`, and writes the whole definition back, so the formula, error
    message, error field and description are preserved exactly. (Deploying a
    stub rule would overwrite them.) The change is re-read afterwards to confirm.
    """
    instance_url, api_version, access_token = _get_auth(target_org)
    base = f"/services/data/v{api_version}/tooling/sobjects/ValidationRule"

    records = _vr_query(instance_url, api_version, access_token, object_api, rule_name)
    if not records:
        raise RuntimeError(f"Validation rule '{rule_name}' not found on {object_api}")
    rule_id = records[0]["Id"]

    record   = _tooling_request(instance_url, access_token, "GET", f"{base}/{rule_id}") or {}
    metadata = record.get("Metadata")
    if not isinstance(metadata, dict) or not metadata.get("errorConditionFormula"):
        raise RuntimeError(
            f"Refusing to change '{rule_name}': could not read its current definition"
        )
    if bool(metadata.get("active")) == active:
        return  # already in the requested state

    new_metadata = {k: v for k, v in metadata.items() if v is not None}
    new_metadata["active"] = active
    _tooling_request(instance_url, access_token, "PATCH", f"{base}/{rule_id}",
                     body={"Metadata": new_metadata})

    check = _tooling_request(instance_url, access_token, "GET", f"{base}/{rule_id}") or {}
    after = (check.get("Metadata") or {})
    if bool(after.get("active")) != active:
        raise RuntimeError(f"Update of '{rule_name}' was not applied (still active={after.get('active')})")
    if after.get("errorConditionFormula") != metadata.get("errorConditionFormula"):
        raise RuntimeError(f"Formula of '{rule_name}' changed unexpectedly after update")

# ---------------------------------------------------------------------------
# REST Explorer proxy
# ---------------------------------------------------------------------------

def sf_rest_request(target_org: str, method: str, path: str, body: str = None) -> dict:
    """Forward an arbitrary REST request to Salesforce using the org's session.

    Args:
        target_org: org alias
        method:     HTTP method (GET, POST, PUT, PATCH, DELETE)
        path:       SF REST path, e.g. /services/data/v68.0/sobjects/Account
        body:       JSON string body for POST/PUT/PATCH (optional)

    Returns:
        { "status": <int>, "headers": {...}, "body": <parsed JSON or raw string> }
    """
    import urllib.request, urllib.error, urllib.parse

    instance_url, api_version, access_token = _get_auth(target_org)

    # If path is relative (no leading /services/), prepend the base data path
    if not path.startswith("/"):
        path = "/" + path

    url = f"{instance_url}{path}"

    data = body.encode("utf-8") if body else None
    req  = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Authorization", f"Bearer {access_token}")
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw     = resp.read().decode("utf-8")
            status  = resp.status
            headers = dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw     = e.read().decode("utf-8")
        status  = e.code
        headers = dict(e.headers)

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        parsed = raw  # return raw string if not JSON

    return {"status": status, "headers": headers, "body": parsed}


# ---------------------------------------------------------------------------
# Security Settings (Metadata API retrieve)
# ---------------------------------------------------------------------------

def _scratch_dir():
    """Temp directory that never raises on cleanup (works on Python 3.9+).

    On Windows the CLI can still hold the directory as its cwd when we delete it;
    the caller has already read what it needs by then, so a failed delete is ignored.
    (tempfile.TemporaryDirectory(ignore_cleanup_errors=True) would be simpler but
    needs Python 3.10.)
    """
    import contextlib
    import shutil

    @contextlib.contextmanager
    def _cm():
        d = tempfile.mkdtemp()
        try:
            yield d
        finally:
            shutil.rmtree(d, ignore_errors=True)

    return _cm()


def get_security_settings(target_org: str) -> dict:
    """Retrieve the org's Security settings and return the values the Health tab uses.

    Retrieves the `Settings:Security` metadata (settings/Security.settings-meta.xml)
    into a throw-away temp directory and parses it. Nothing is kept on disk.

    Returns:
    {
      "passwordPolicies":    { minimumPasswordLength, complexity, expiration,
                               maxLoginAttempts, lockoutInterval, ... },
      "sessionSettings":     { sessionTimeout, forceRelogin, requireHttps,
                               enforceIpRangesEveryRequest, lockSessionsToDomain, ... },
      "loginAccessPolicies": { administratorsCanLogInAsAny },
      "ipRanges": [ { start, end, description }, ... ]
    }
    Values are the raw strings from the XML ("true"/"false", enum names).
    """
    import xml.etree.ElementTree as ET

    with _scratch_dir() as tmpdir:
        tmp = Path(tmpdir)

        # Minimal sfdx-project.json. The retrieve target must NOT overlap a package
        # directory, so the output goes to a separate "retrieved" folder.
        (tmp / "sfdx-project.json").write_text(json.dumps({
            "packageDirectories": [{"path": "force-app", "default": True}],
            "namespace": "",
            "sourceApiVersion": "68.0",
        }))
        (tmp / "force-app").mkdir()
        output_dir = tmp / "retrieved"
        output_dir.mkdir()

        resp = _sf(
            "project", "retrieve", "start",
            "--metadata", "Settings:Security",
            "--target-org", target_org,
            "--output-dir", str(output_dir),
            "--wait", "5",
            timeout=360,
            cwd=str(tmp),
        )
        # _sf() returns CLI error JSON instead of raising, so check it here.
        if isinstance(resp, dict) and resp.get("status") not in (0, None):
            raise RuntimeError(
                f"Security settings retrieve failed: {resp.get('name', '')} {resp.get('message', '')}".strip()
            )

        files = list(output_dir.rglob("Security.settings-meta.xml"))
        if not files:
            raise RuntimeError("Security settings retrieve returned no Security.settings-meta.xml")

        root = ET.parse(files[0]).getroot()
        ns   = root.tag.split("}")[0].lstrip("{") if "}" in root.tag else ""

        def tag(name):
            return f"{{{ns}}}{name}" if ns else name

        def child_text(parent, name):
            el = parent.find(tag(name)) if parent is not None else None
            return el.text if el is not None else None

        result = {
            "passwordPolicies":    {},
            "sessionSettings":     {},
            "loginAccessPolicies": {},
            "ipRanges":            [],
        }

        pp = root.find(tag("passwordPolicies"))
        for field in ("minimumPasswordLength", "complexity", "expiration", "maxLoginAttempts",
                      "lockoutInterval", "minimumPasswordLifetime", "historyRestriction"):
            val = child_text(pp, field)
            if val is not None:
                result["passwordPolicies"][field] = val

        ss = root.find(tag("sessionSettings"))
        for field in ("sessionTimeout", "forceRelogin", "enforceIpRangesEveryRequest",
                      "lockSessionsToDomain", "lockSessionsToIp", "requireHttpOnly"):
            val = child_text(ss, field)
            if val is not None:
                result["sessionSettings"][field] = val

        # These two live at the top level of the file, under different names.
        https = child_text(root, "enableRequireHttpsConnection")
        if https is not None:
            result["sessionSettings"]["requireHttps"] = https
        admin = child_text(root, "enableAdminLoginAsAnyUser")
        if admin is not None:
            result["loginAccessPolicies"]["administratorsCanLogInAsAny"] = admin

        na = root.find(tag("networkAccess"))
        if na is not None:
            for ipr in na.findall(tag("ipRanges")):
                entry = {f: child_text(ipr, f) for f in ("start", "end", "description")}
                entry = {k: v for k, v in entry.items() if v is not None}
                if entry:
                    result["ipRanges"].append(entry)

        return result