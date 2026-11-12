"""
sf_skills.py — Salesforce skill RAG context for the Avio AI chat.

Loads bundled SKILL.md and reference files from backend/sf_skills/ by default.
Supports three source modes (configured via ~/.avio_config.json):

  skills_source = "bundled"  — reads from sf_skills/ next to this file (default)
  skills_source = "path"     — reads from a local directory (skills_path config key)
                               Airgap / internal mirror: point to a network share or
                               a checkout of an internal fork of forcedotcom/sf-skills
  skills_source = "url"      — fetches over HTTP from an internal server (skills_url)
                               Must return the same directory tree as forcedotcom/sf-skills

  skills_enabled = false     — disables augmentation entirely (no files read, no prompt
                               injection). Useful for airgap environments where even
                               local reads are undesirable, or for troubleshooting.

Bundled files are cherry-picked from forcedotcom/sf-skills.
See sf_skills/VERSION for the upstream commit.
"""
from __future__ import annotations

import re
import json
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_HERE       = Path(__file__).resolve().parent
SKILLS_DIR  = _HERE / "sf_skills"          # default bundled location

from platform_env import avio_data_dir as _avio_data_dir
CONFIG_PATH  = _avio_data_dir() / "config.json"
USER_SKILLS  = _avio_data_dir() / "skills"   # downloaded/imported skills live here

GH_RAW_BASE  = "https://raw.githubusercontent.com/forcedotcom/sf-skills/main"

# ---------------------------------------------------------------------------
# Skill file manifest  (relative paths within any skills root directory)
# ---------------------------------------------------------------------------
SKILL_FILES: dict[str, list[str]] = {
    "platform-soql-query": [
        "platform-soql-query/SKILL.md",
        "platform-soql-query/references/anti-patterns.md",
        "platform-soql-query/references/query-optimization.md",
        "platform-soql-query/references/soql-reference.md",
    ],
    "platform-apex-generate": [
        "platform-apex-generate/SKILL.md",
    ],
}

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _load_skills_config() -> dict:
    """Return the skills-related keys from ~/.avio_config.json."""
    try:
        if CONFIG_PATH.exists():
            raw = json.loads(CONFIG_PATH.read_text())
            return {
                "enabled":       raw.get("skills_enabled", True),
                "source":        raw.get("skills_source",  "bundled"),
                "path":          raw.get("skills_path",    None),
                "url":           raw.get("skills_url",     None),
                "custom_skills": raw.get("custom_skills",  []),
            }
    except Exception as e:
        log.debug("sf_skills: could not read config — %s", e)
    return {"enabled": True, "source": "bundled", "path": None, "url": None, "custom_skills": []}


def _resolve_skills_root(cfg: dict) -> Optional[Path]:
    """
    Return the root Path to read skill files from, based on config.
    Returns None if the source uses HTTP (github or url) — caller handles fetch.
    """
    source = cfg.get("source", "bundled")

    if source == "bundled":
        return SKILLS_DIR

    if source == "github":
        return None   # fetched from GitHub raw CDN

    if source == "path":
        raw = cfg.get("path") or ""
        p = Path(raw.strip()).expanduser()
        if p.is_dir():
            return p
        log.warning("sf_skills: skills_path '%s' not found — falling back to bundled", p)
        return SKILLS_DIR

    if source == "url":
        return None   # HTTP path handled separately

    log.warning("sf_skills: unknown skills_source '%s' — falling back to bundled", source)
    return SKILLS_DIR


def _effective_base_url(cfg: dict) -> str:
    """Return the HTTP base URL for github or url sources. Empty string otherwise."""
    source = cfg.get("source", "bundled")
    if source == "github":
        return GH_RAW_BASE
    if source == "url":
        return (cfg.get("url") or "").rstrip("/")
    return ""


# ---------------------------------------------------------------------------
# Intent detection  — keyword sets that trigger each skill
# ---------------------------------------------------------------------------
_SOQL_RE = re.compile(
    r"\b(soql|select\s+\w|query|queries|where\s+clause|governor.limit|"
    r"relationship.quer|aggregate|count\s*\(|sosl|query.plan|"
    r"index|selectiv|bulk\s+quer|anti.pattern|from\s+account|"
    r"from\s+contact|from\s+opportunity|from\s+case|from\s+lead|"
    r"from\s+\w+__c|order\s+by|limit\s+\d|subquery)\b",
    re.IGNORECASE,
)

_APEX_RE = re.compile(
    r"\b(apex|\.cls|trigger|batch\s+apex|queueable|schedulable|"
    r"invocable|aura.enabled|rest.resource|soql.inside.loop|"
    r"bulkif|with.sharing|without.sharing|database\.(insert|update|delete)|"
    r"dml\s+statement|future\s+method|platform.event|apex.class|"
    r"apex.trigger|selector\s+class|service\s+class|domain\s+class)\b",
    re.IGNORECASE,
)


def detect_skills(messages: list[dict]) -> list[str]:
    """Return list of skill names relevant to the conversation."""
    user_texts = [
        m["content"] for m in messages[-6:]
        if m.get("role") == "user" and isinstance(m.get("content"), str)
    ]
    combined = " ".join(user_texts)

    skills: list[str] = []
    if _SOQL_RE.search(combined):
        skills.append("platform-soql-query")
    if _APEX_RE.search(combined):
        skills.append("platform-apex-generate")
    return skills


# ---------------------------------------------------------------------------
# File loading — local path and HTTP
# ---------------------------------------------------------------------------

def _load_file_local(root: Path, rel_path: str) -> Optional[str]:
    path = root / rel_path
    if not path.exists():
        log.debug("sf_skills: file not found: %s", path)
        return None
    try:
        content = path.read_text(encoding="utf-8")
        content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL).strip()
        return content
    except Exception as e:
        log.debug("sf_skills: read error %s — %s", path, e)
        return None


def _load_file_url(base_url: str, rel_path: str) -> Optional[str]:
    """
    Fetch a skill file from an internal HTTP server.
    base_url should be the root of an sf-skills mirror, e.g.:
      https://skills.internal.corp/sf-skills
    """
    import urllib.request
    url = base_url.rstrip("/") + "/" + rel_path
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            content = resp.read().decode("utf-8")
            content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL).strip()
            return content
    except Exception as e:
        log.warning("sf_skills: HTTP fetch failed %s — %s", url, e)
        return None


# ---------------------------------------------------------------------------
# Custom skill helpers
# ---------------------------------------------------------------------------

_GH_RAW_BASE = "https://raw.githubusercontent.com/forcedotcom/sf-skills/main"

def _load_custom_skill_context(entry: dict) -> Optional[str]:
    """
    Load all markdown files for a custom skill entry.
    entry = {"name": "...", "path": "/abs/path/to/skill-dir"}
           or {"name": "...", "path": "https://raw.githubusercontent.com/..."}
           or {"name": "...", "path": "file:///local/path/to/skill-dir"}

    For HTTP(S) paths: fetches SKILL.md and known reference files from the URL base.
    For local paths (including file:// URLs): reads from the filesystem.
    Returns a formatted markdown block or None if the source is inaccessible.
    """
    raw_path = (entry.get("path") or "").strip()
    if not raw_path:
        return None

    name = entry.get("name") or raw_path.rstrip("/").split("/")[-1]

    # ── HTTP(S) source ────────────────────────────────────────────────────────
    if raw_path.startswith("http://") or raw_path.startswith("https://"):
        base_url = raw_path.rstrip("/")
        # Always fetch SKILL.md; also try common reference files
        candidate_paths = ["SKILL.md"]
        # Probe for a references/ directory by trying known filenames
        for ref in ["anti-patterns.md", "query-optimization.md", "soql-reference.md",
                    "best-practices.md", "patterns.md", "reference.md", "guidelines.md"]:
            candidate_paths.append(f"references/{ref}")

        parts = []
        for rel in candidate_paths:
            content = _load_file_url(base_url, rel)
            if content:
                parts.append(content)
        if not parts:
            log.warning("sf_skills: custom skill URL returned no content: %s", base_url)
            return None
        return f"## {name} (custom)\n\n" + "\n\n---\n\n".join(parts)

    # ── bundled: sentinel → resolve to SKILLS_DIR/slug ───────────────────────
    if raw_path.startswith("bundled:"):
        slug = raw_path[len("bundled:"):]
        raw_path = str(SKILLS_DIR / slug)

    # ── file:// URL → strip scheme ────────────────────────────────────────────
    if raw_path.startswith("file://"):
        raw_path = raw_path[7:]

    # ── Local filesystem ──────────────────────────────────────────────────────
    root = Path(raw_path).expanduser()
    if not root.is_dir():
        log.warning("sf_skills: custom skill path not found: %s", root)
        return None

    parts = []
    skill_md = root / "SKILL.md"
    if skill_md.exists():
        content = _load_file_local(root, "SKILL.md")
        if content:
            parts.append(content)
    for md in sorted(root.rglob("*.md")):
        if md == skill_md:
            continue
        try:
            content = md.read_text(encoding="utf-8")
            content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL).strip()
            if content:
                parts.append(content)
        except Exception as e:
            log.debug("sf_skills: custom skill read error %s — %s", md, e)

    if not parts:
        return None
    return f"## {name} (custom)\n\n" + "\n\n---\n\n".join(parts)


def fetch_skill(name: str, source: str) -> dict:
    """
    Download or copy a skill into ~/.avio_skills/<name>/ and return a status dict.

    source can be:
      - "bundled:<slug>"             copy from SKILLS_DIR/<slug>
      - "https://..." or "http://..." fetch markdown files from a raw HTTP server
      - "file:///..." or "/abs/path"  copy from a local directory
      - "github:<slug>"              fetch from GH_RAW_BASE/<slug>

    Returns {"ok": bool, "path": str, "files": int, "error": str|None}
    """
    import shutil

    slug = name.strip().replace(" ", "-").lower()
    dest = USER_SKILLS / slug
    dest.mkdir(parents=True, exist_ok=True)

    files_written = 0

    try:
        # ── bundled sentinel ──────────────────────────────────────────────────
        if source.startswith("bundled:"):
            skill_slug = source[len("bundled:"):]
            src_dir = SKILLS_DIR / skill_slug
            if not src_dir.is_dir():
                return {"ok": False, "path": str(dest), "files": 0, "error": f"Bundled skill '{skill_slug}' not found"}
            for md in src_dir.rglob("*.md"):
                rel = md.relative_to(src_dir)
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(md, out)
                files_written += 1

        # ── GitHub shorthand ──────────────────────────────────────────────────
        elif source.startswith("github:"):
            skill_slug = source[len("github:"):]
            base_url = f"{GH_RAW_BASE}/{skill_slug}"
            files_written = _fetch_skill_from_url(base_url, dest)

        # ── HTTP(S) URL ───────────────────────────────────────────────────────
        elif source.startswith("http://") or source.startswith("https://"):
            files_written = _fetch_skill_from_url(source.rstrip("/"), dest)

        # ── file:// or local path ─────────────────────────────────────────────
        else:
            raw = source[7:] if source.startswith("file://") else source
            src_dir = Path(raw).expanduser()
            if not src_dir.is_dir():
                return {"ok": False, "path": str(dest), "files": 0, "error": f"Directory not found: {src_dir}"}
            for md in src_dir.rglob("*.md"):
                rel = md.relative_to(src_dir)
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(md, out)
                files_written += 1

        # Write a meta file so we know the origin
        (dest / ".avio_skill_meta.json").write_text(
            json.dumps({"name": name, "source": source, "fetched": str(Path(__file__).parent)}, indent=2)
        )

        if files_written == 0:
            return {"ok": False, "path": str(dest), "files": 0, "error": "No markdown files found at source"}

        log.info("sf_skills: fetched '%s' → %s (%d files)", name, dest, files_written)
        return {"ok": True, "path": str(dest), "files": files_written, "error": None}

    except Exception as e:
        log.error("sf_skills: fetch_skill failed for '%s': %s", name, e)
        return {"ok": False, "path": str(dest), "files": 0, "error": str(e)}


def _fetch_skill_from_url(base_url: str, dest: Path) -> int:
    """
    Fetch SKILL.md and known reference files from a raw HTTP base URL into dest/.
    Returns number of files written.
    """
    import datetime
    candidates = [
        "SKILL.md",
        "references/anti-patterns.md",
        "references/query-optimization.md",
        "references/soql-reference.md",
        "references/best-practices.md",
        "references/patterns.md",
        "references/reference.md",
        "references/guidelines.md",
        "references/examples.md",
    ]
    written = 0
    for rel in candidates:
        content = _load_file_url(base_url, rel)
        if content:
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(content, encoding="utf-8")
            written += 1
    return written


def _build_user_skills_context() -> str:
    """
    Build context block for all skills in ~/.avio_skills/.
    These are skills downloaded/imported by the user via Add Skill.
    Returns '' if none exist.
    """
    if not USER_SKILLS.is_dir():
        return ""
    sections = []
    for skill_dir in sorted(USER_SKILLS.iterdir()):
        if not skill_dir.is_dir():
            continue
        # Read display name from meta
        display = skill_dir.name
        meta_file = skill_dir / ".avio_skill_meta.json"
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text())
                display = meta.get("name") or display
            except Exception:
                pass
        parts = []
        skill_md = skill_dir / "SKILL.md"
        if skill_md.exists():
            content = _load_file_local(skill_dir, "SKILL.md")
            if content:
                parts.append(content)
        for md in sorted(skill_dir.rglob("*.md")):
            if md == skill_md or md.name.startswith("."):
                continue
            try:
                content = md.read_text(encoding="utf-8")
                content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL).strip()
                if content:
                    parts.append(content)
            except Exception:
                pass
        if parts:
            sections.append(f"## {display}\n\n" + "\n\n---\n\n".join(parts))

    if not sections:
        return ""
    return (
        "\n\n"
        "=== ADDITIONAL SKILL REFERENCE ===\n"
        "The following additional guidance has been added to Avio.\n\n"
        + "\n\n===\n\n".join(sections)
        + "\n\n=== END ADDITIONAL SKILL REFERENCE ==="
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_skill_context(skills: list[str], cfg: Optional[dict] = None) -> str:
    """
    Assemble skill markdown for the given skill names into a single block
    ready to append to the system prompt. Returns "" if nothing available.
    """
    if not skills:
        return ""

    if cfg is None:
        cfg = _load_skills_config()

    root     = _resolve_skills_root(cfg)
    use_http = (root is None)
    base_url = _effective_base_url(cfg) if use_http else ""

    sections: list[str] = []
    for skill in skills:
        files = SKILL_FILES.get(skill, [])
        parts = []
        for f in files:
            content = (
                _load_file_url(base_url, f) if use_http
                else _load_file_local(root, f)
            )
            if content:
                parts.append(content)
        if parts:
            sections.append(f"## {skill}\n\n" + "\n\n---\n\n".join(parts))

    if not sections:
        return ""

    return (
        "\n\n"
        "=== SALESFORCE SKILL REFERENCE (forcedotcom/sf-skills) ===\n"
        "The following official Salesforce guidance applies to this request. "
        "Follow these rules and patterns precisely.\n\n"
        + "\n\n===\n\n".join(sections)
        + "\n\n=== END SALESFORCE SKILL REFERENCE ==="
    )


def augment_system(system: Optional[str], messages: list[dict]) -> str:
    """
    Detect relevant skills from message history and append their context
    to the system prompt. Returns the (possibly unchanged) system string.
    Respects skills_enabled and skills_source config from ~/.avio_config.json.
    """
    cfg = _load_skills_config()

    if not cfg.get("enabled", True):
        return system or ""

    skills = detect_skills(messages)
    if not skills:
        return system or ""

    skill_ctx = build_skill_context(skills, cfg)
    if not skill_ctx:
        return system or ""

    log.info("sf_skills: injecting skills %s (source=%s)", skills, cfg.get("source"))
    result = (system or "") + skill_ctx

    # Also inject any user-downloaded skills from ~/.avio_skills/
    user_ctx = _build_user_skills_context()
    if user_ctx:
        result += user_ctx

    return result


# ---------------------------------------------------------------------------
# Manifest — for /api/ai/skills endpoint
# ---------------------------------------------------------------------------

def get_skills_manifest(config_override: Optional[dict] = None) -> dict:
    """
    Return a dict describing bundled skills, config state, and version info.
    Used by the /api/ai/skills endpoint to power the Settings UI panel.
    Pass config_override to test a draft config without saving it first.
    """
    cfg = _load_skills_config()
    if config_override:
        cfg = {**cfg, **config_override}
    root = _resolve_skills_root(cfg)

    # Version info
    version_info = {}
    version_file = SKILLS_DIR / "VERSION"
    if version_file.exists():
        try:
            raw = version_file.read_text()
            kv: dict[str, str] = {}
            for line in raw.splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    kv[k.strip()] = v.strip()
            upstream = kv.get("upstream-commit", "")
            parts = upstream.split()
            version_info = {
                "commit":  parts[0] if parts else "unknown",
                "date":    parts[1] if len(parts) > 1 else kv.get("fetched", ""),
                "source":  kv.get("source", ""),
                "fetched": kv.get("fetched", ""),
            }
        except Exception:
            version_info = {"commit": "unknown", "date": ""}

    # Build full catalog — bundled skills first, then upstream-only ones
    skills_status = []

    for skill_name in _UPSTREAM_CATALOG:
        is_bundled = skill_name in SKILL_FILES
        files      = SKILL_FILES.get(skill_name, [])

        if not is_bundled:
            # Not yet bundled — show in catalog as coming soon
            skills_status.append({
                "name":        skill_name,
                "label":       _SKILL_LABELS.get(skill_name, skill_name),
                "description": _SKILL_DESCS.get(skill_name, ""),
                "file_count":  0,
                "available":   False,
                "bundled":     False,
            })
            continue

        if cfg.get("source") in ("url", "github"):
            available  = True  # optimistic — can't probe without fetching
            file_count = len(files)
        elif root:
            file_count = sum(1 for f in files if (root / f).exists())
            available  = file_count > 0
        else:
            available  = False
            file_count = 0

        skills_status.append({
            "name":        skill_name,
            "label":       _SKILL_LABELS.get(skill_name, skill_name),
            "description": _SKILL_DESCS.get(skill_name, ""),
            "file_count":  file_count,
            "available":   available,
            "bundled":     True,
        })

    # Append skills from ~/.avio_skills/ — downloaded/imported by the user
    if USER_SKILLS.is_dir():
        for skill_dir in sorted(USER_SKILLS.iterdir()):
            if not skill_dir.is_dir():
                continue
            # Read meta if present for display name
            meta = {}
            meta_file = skill_dir / ".avio_skill_meta.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                except Exception:
                    pass
            skill_md   = skill_dir / "SKILL.md"
            file_count = sum(1 for f in skill_dir.rglob("*.md") if not f.name.startswith("."))
            available  = skill_md.exists() and file_count > 0
            display    = meta.get("name") or skill_dir.name
            source_url = meta.get("source", "")
            skills_status.append({
                "name":        skill_dir.name,
                "label":       display,
                "description": source_url or str(skill_dir),
                "file_count":  file_count,
                "available":   available,
                "bundled":     True,
                "user":        True,   # downloaded by user, not shipped with app
            })

    source = cfg.get("source", "bundled")
    return {
        "enabled":     cfg.get("enabled", True),
        "source":      source,
        "skills_path": cfg.get("path") or "",
        "skills_url":  cfg.get("url") or (GH_RAW_BASE if source == "github" else ""),
        "version":     version_info,
        "skills":      skills_status,
    }


_SKILL_LABELS = {
    "platform-soql-query":            "SOQL Query",
    "platform-apex-generate":         "Apex Generate",
    "platform-apex-refactor":         "Apex Refactor",
    "platform-apex-unittest":         "Apex Unit Test",
    "platform-flows-generate":        "Flows Generate",
    "platform-lwc-generate":          "LWC Generate",
    "platform-metadata-retrieve":     "Metadata Retrieve",
    "platform-metadata-deploy":       "Metadata Deploy",
    "platform-permissions-analyze":   "Permissions Analyze",
}

_SKILL_DESCS = {
    "platform-soql-query":            "SOQL authoring, optimization, anti-patterns, and reference",
    "platform-apex-generate":         "Apex class and trigger generation, best practices",
    "platform-apex-refactor":         "Apex code refactoring and modernization",
    "platform-apex-unittest":         "Apex unit test authoring and coverage guidance",
    "platform-flows-generate":        "Salesforce Flow and Process Builder authoring",
    "platform-lwc-generate":          "Lightning Web Component generation and patterns",
    "platform-metadata-retrieve":     "Metadata API retrieve operations and packaging",
    "platform-metadata-deploy":       "Metadata API deploy, validation, and rollback",
    "platform-permissions-analyze":   "Permission set and profile security analysis",
}

# Skills in the upstream repo not yet bundled — shown in the UI as coming soon
_UPSTREAM_CATALOG = [
    "platform-soql-query",           # bundled
    "platform-apex-generate",        # bundled
    "platform-apex-refactor",
    "platform-apex-unittest",
    "platform-flows-generate",
    "platform-lwc-generate",
    "platform-metadata-retrieve",
    "platform-metadata-deploy",
    "platform-permissions-analyze",
]
