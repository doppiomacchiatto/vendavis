"""
Claude API client — wraps Anthropic SDK.
Supports both one-shot and streaming calls.
Config: ANTHROPIC_API_KEY env var or ~/.anthropic_key.
Model and base_url are read from ~/.vendavis_config.json (written by settings modal).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Generator, Optional

import anthropic

DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 4096

CONFIG_PATH      = Path.home() / ".vendavis_config.json"
LEGACY_CFG_PATH  = Path.home() / ".sf_tools_config.json"   # old SOQL Explorer config


def _load_config() -> dict:
    """Load ~/.vendavis_config.json; returns {} if missing/invalid."""
    try:
        if CONFIG_PATH.exists():
            return json.loads(CONFIG_PATH.read_text())
    except Exception:
        pass
    return {}


def _load_legacy_config() -> dict:
    """Load ~/.sf_tools_config.json (old SOQL Explorer / sf_fls_exporter config)."""
    try:
        if LEGACY_CFG_PATH.exists():
            return json.loads(LEGACY_CFG_PATH.read_text())
    except Exception:
        pass
    return {}


def save_config(model: str = "", base_url: str = "") -> None:
    """Merge model/base_url into config file."""
    cfg = _load_config()
    if model:
        cfg["model"] = model
    if base_url is not None:
        cfg["base_url"] = base_url
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def _load_api_key() -> str:
    """Return API key — checks (in priority order):
    1. ANTHROPIC_API_KEY env var
    2. ~/.anthropic_key  (written by Vendavis Settings modal)
    3. ~/.sf_tools_config.json  api_key field (legacy SOQL Explorer config)
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        p = Path.home() / ".anthropic_key"
        if p.exists():
            key = p.read_text().strip()
    if not key:
        legacy = _load_legacy_config()
        key = legacy.get("api_key", "").strip()
    if not key:
        raise RuntimeError(
            "No Anthropic API key found. Set ANTHROPIC_API_KEY env var, "
            "write it to ~/.anthropic_key, or open ⚙ Settings."
        )
    return key


def _load_base_url() -> str:
    """Return base_url — checks vendavis config first, then legacy config."""
    cfg = _load_config()
    url = cfg.get("base_url", "").strip()
    if not url:
        legacy = _load_legacy_config()
        url = legacy.get("base_url", "").strip()
    return url


class ClaudeClient:
    def __init__(self):
        self._client = None  # lazy — recreated when config changes

    def _get_client(self, force_refresh: bool = False):
        if self._client is None or force_refresh:
            base_url = _load_base_url() or None
            kwargs: dict = {"api_key": _load_api_key()}
            if base_url:
                kwargs["base_url"] = base_url
            self._client = anthropic.Anthropic(**kwargs)
        return self._client

    def _model(self) -> str:
        cfg = _load_config()
        return cfg.get("model", "").strip() or DEFAULT_MODEL

    # ------------------------------------------------------------------
    # One-shot (returns full text)
    # ------------------------------------------------------------------
    def ask(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        max_tokens: int = MAX_TOKENS,
        model: Optional[str] = None,
    ) -> str:
        kwargs: dict = dict(
            model=model or self._model(),
            max_tokens=max_tokens,
            messages=messages,
        )
        if system:
            kwargs["system"] = system
        resp = self._get_client().messages.create(**kwargs)
        return resp.content[0].text

    # ------------------------------------------------------------------
    # Streaming (yields text deltas)
    # ------------------------------------------------------------------
    def stream(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        max_tokens: int = MAX_TOKENS,
        model: Optional[str] = None,
    ) -> Generator[str, None, None]:
        kwargs: dict = dict(
            model=model or self._model(),
            max_tokens=max_tokens,
            messages=messages,
        )
        if system:
            kwargs["system"] = system
        with self._get_client().messages.stream(**kwargs) as s:
            for delta in s.text_stream:
                yield delta
