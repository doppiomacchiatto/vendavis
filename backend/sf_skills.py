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
CONFIG_PATH = Path.home() / ".avio_config.json"

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
                "enabled": raw.get("skills_enabled", True),
                "source":  raw.get("skills_source",  "bundled"),
                "path":    raw.get("skills_path",    None),
                "url":     raw.get("skills_url",     None),
            }
    except Exception as e:
        log.debug("sf_skills: could not read config — %s", e)
    return {"enabled": True, "source": "bundled", "path": None, "url": None}


def _resolve_skills_root(cfg: dict) -> Optional[Path]:
    """
    Return the root Path to read skill files from, based on config.
    Returns None if the source is 'url' (caller handles HTTP) or unreachable.
    """
    source = cfg.get("source", "bundled")

    if source == "bundled":
        return SKILLS_DIR

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
    base_url = (cfg.get("url") or "").rstrip("/") if use_http else ""

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
    return (system or "") + skill_ctx


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

    # Skill status — check whether each skill's primary SKILL.md is readable
    skills_status = []
    for skill_name, files in SKILL_FILES.items():
        primary = files[0] if files else ""
        if cfg.get("source") == "url":
            available = bool(cfg.get("url"))  # optimistic — can't probe without fetching
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
        })

    return {
        "enabled":       cfg.get("enabled", True),
        "source":        cfg.get("source", "bundled"),
        "skills_path":   cfg.get("path") or "",
        "skills_url":    cfg.get("url") or "",
        "version":       version_info,
        "skills":        skills_status,
    }


_SKILL_LABELS = {
    "platform-soql-query":    "SOQL Query",
    "platform-apex-generate": "Apex Generate",
}

_SKILL_DESCS = {
    "platform-soql-query":    "SOQL authoring, optimization, anti-patterns, and reference",
    "platform-apex-generate": "Apex class and trigger generation, best practices",
}
