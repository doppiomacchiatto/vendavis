"""
sf_cli.py — Salesforce CLI wrappers for sf_fls_exporter.

All functions here are pure (no UI), thread-safe, and importable independently.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from platform_env import get_platform

SF_CLI = None   # resolved lazily on first call


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


def _sf(*args, timeout=120):
    """Run an sf/sfdx command and return parsed JSON output."""
    global SF_CLI
    if SF_CLI is None:
        SF_CLI = _find_sf_cli()

    cmd = [SF_CLI, *args, "--json"]
    env = {**os.environ, "PATH": _augmented_path()}
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)

    import re as _re
    # Strip ANSI color codes before parsing
    clean = _re.sub(r'\x1b\[[0-9;]*m', '', result.stdout).strip()

    # Always try to parse stdout as JSON first — the SF CLI returns rc=2 for
    # warnings (e.g. "update available") even when the command succeeded and
    # stdout contains valid JSON output.
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        pass

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
    api_version  = result.get("apiVersion") or result.get("api_version") or "59.0"

    # sf org display redacts the token — use the dedicated command
    token_info   = _sf("org", "auth", "show-access-token", "--target-org", target_org)
    token_result = token_info.get("result", {})
    access_token = token_result.get("accessToken") or token_result.get("access_token")

    if not access_token or not instance_url:
        raise RuntimeError(
            f"Could not retrieve access token or instance URL. "
            f"Token result keys: {list(token_result.keys())}"
        )

    url = f"{instance_url}/services/data/v{api_version}/limits"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            limits = json.loads(body)
            return limits
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Limits API error {e.code}: {e.read().decode()[:200]}")


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


def list_objects(target_org):
    """Return sorted list of (api_name, label) tuples for all objects.

    Uses EntityDefinition SOQL — works with all CLI versions.
    EntityDefinition has a max SOQL limit; we page through with OFFSET.
    """
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
    api_version  = result.get("apiVersion")  or result.get("api_version")  or "59.0"
    token_info   = _sf("org", "auth", "show-access-token", "--target-org", target_org)
    access_token = (token_info.get("result") or {}).get("accessToken") or \
                   (token_info.get("result") or {}).get("access_token")
    if not access_token or not instance_url:
        raise RuntimeError("Could not retrieve access token or instance URL.")
    return instance_url, api_version, access_token


def get_validation_rules(target_org: str, object_api: str) -> list:
    """Fetch all validation rules for an object via the Tooling API.

    Returns a list of dicts:
      { id, name, active, errorField, errorConditionFormula, errorMessage, description }
    """
    import urllib.request, urllib.error
    instance_url, api_version, access_token = _get_auth(target_org)

    import urllib.parse
    soql = (
        "SELECT Id, Active, ValidationName, ErrorDisplayField, "
        "ErrorConditionFormula, ErrorMessage, Description "
        f"FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '{object_api}' "
        "ORDER BY ValidationName"
    )
    url = (
        f"{instance_url}/services/data/v{api_version}/tooling/query"
        f"?q={urllib.parse.quote(soql)}"
    )
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Tooling API error {e.code}: {e.read().decode()[:300]}")

    rules = []
    for r in data.get("records", []):
        rules.append({
            "id":                    r.get("Id", ""),
            "name":                  r.get("ValidationName", ""),
            "active":                r.get("Active", False),
            "errorField":            r.get("ErrorDisplayField") or "",
            "errorConditionFormula": r.get("ErrorConditionFormula") or "",
            "errorMessage":          r.get("ErrorMessage") or "",
            "description":           r.get("Description") or "",
        })
    return rules


def toggle_validation_rule(target_org: str, object_api: str, rule_name: str, active: bool) -> None:
    """Enable or disable a validation rule by deploying a minimal Metadata XML.

    Uses a temp directory so that `sf project deploy start` has the required
    sfdx-project.json and objects/ structure.
    """
    import shutil

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # sfdx-project.json — minimal, required for the deploy command
        (tmp / "sfdx-project.json").write_text(json.dumps({
            "packageDirectories": [{"path": "force-app", "default": True}],
            "namespace": "",
            "sourceApiVersion": "59.0",
        }))

        # force-app/main/default/objects/{Object}/validationRules/
        vr_dir = tmp / "force-app" / "main" / "default" / "objects" / object_api / "validationRules"
        vr_dir.mkdir(parents=True)

        active_str = "true" if active else "false"
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            f'    <fullName>{rule_name}</fullName>\n'
            f'    <active>{active_str}</active>\n'
            f'    <errorConditionFormula>true</errorConditionFormula>\n'
            f'    <errorMessage>placeholder</errorMessage>\n'
            '</ValidationRule>\n'
        )
        (vr_dir / f"{rule_name}.validationRule-meta.xml").write_text(xml)

        # Deploy — wait for completion (--wait 10 minutes max)
        result = _sf(
            "project", "deploy", "start",
            "--source-dir", str(tmp / "force-app"),
            "--target-org", target_org,
            "--wait", "10",
            timeout=660,
        )
        status = (result.get("result") or {}).get("status", "")
        if status not in ("Succeeded", "SucceededPartial", ""):
            errors = (result.get("result") or {}).get("details", {}).get("componentFailures", [])
            msg = "; ".join(e.get("problem", "") for e in errors) if errors else str(result)
            raise RuntimeError(f"Deploy failed ({status}): {msg}")


# ---------------------------------------------------------------------------
# REST Explorer proxy
# ---------------------------------------------------------------------------

def sf_rest_request(target_org: str, method: str, path: str, body: str = None) -> dict:
    """Forward an arbitrary REST request to Salesforce using the org's session.

    Args:
        target_org: org alias
        method:     HTTP method (GET, POST, PUT, PATCH, DELETE)
        path:       SF REST path, e.g. /services/data/v59.0/sobjects/Account
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
