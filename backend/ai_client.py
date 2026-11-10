"""
OpenCode AI client — provider-agnostic, OpenAI-compatible API.

Supports any provider that exposes an OpenAI-compatible chat completions
endpoint (OpenAI, Anthropic via compat layer, Azure OpenAI, local Ollama,
custom gateways, etc.).

Config priority (highest → lowest):
  1. opencode.config.json  in project root (developer override)
  2. OPENCODE_API_KEY / OPENCODE_BASE_URL / OPENCODE_MODEL env vars
  3. ~/.vendavis_api_key   (written by Vendavis Settings modal)
  4. ~/.vendavis_config.json  model / base_url fields
  5. Legacy ~/.sf_tools_config.json  (old SOQL Explorer config)
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Generator, Optional

import openai

DEFAULT_MODEL   = "gpt-4o"
MAX_TOKENS      = 4096

CONFIG_PATH      = Path.home() / ".vendavis_config.json"
API_KEY_PATH     = Path.home() / ".vendavis_api_key"
OPENCODE_GATEWAY_URL = "https://opencode.ai/inference/openai/v1"
LEGACY_CFG_PATH  = Path.home() / ".sf_tools_config.json"

# opencode.config.json is looked for relative to the project root.
# In production (bundled app) it can sit next to the binary; in dev it lives
# in the repo root. We walk up from __file__ to find it.
def _find_opencode_config() -> Optional[Path]:
    here = Path(__file__).resolve().parent
    for _ in range(5):
        candidate = here / "opencode.config.json"
        if candidate.exists():
            return candidate
        here = here.parent
    return None


def _load_opencode_config() -> dict:
    p = _find_opencode_config()
    if p:
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


def _load_vendavis_config() -> dict:
    try:
        if CONFIG_PATH.exists():
            return json.loads(CONFIG_PATH.read_text())
    except Exception:
        pass
    return {}


def _load_legacy_config() -> dict:
    try:
        if LEGACY_CFG_PATH.exists():
            return json.loads(LEGACY_CFG_PATH.read_text())
    except Exception:
        pass
    return {}


def save_config(model: str = "", base_url: str = "") -> None:
    """Merge model/base_url into ~/.vendavis_config.json."""
    cfg = _load_vendavis_config()
    if model:
        cfg["model"] = model
    if base_url is not None:
        cfg["base_url"] = base_url
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def _load_api_key() -> str:
    """Return API key from the first available source."""
    # 1. opencode.config.json
    oc = _load_opencode_config()
    if oc.get("api_key"):
        return oc["api_key"].strip()
    # 2. env var
    key = os.environ.get("OPENCODE_API_KEY", "") or os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key.strip()
    # 3. ~/.vendavis_api_key
    if API_KEY_PATH.exists():
        key = API_KEY_PATH.read_text().strip()
        if key:
            return key
    # 4. legacy ~/.anthropic_key
    legacy_key_path = Path.home() / ".anthropic_key"
    if legacy_key_path.exists():
        key = legacy_key_path.read_text().strip()
        if key:
            return key
    # 5. legacy config file
    legacy = _load_legacy_config()
    key = legacy.get("api_key", "").strip()
    if key:
        return key
    raise RuntimeError(
        "No AI API key found. Set OPENCODE_API_KEY env var, "
        "add it to opencode.config.json, write it to ~/.vendavis_api_key, "
        "or open ⚙ Settings."
    )


def _load_base_url() -> str:
    """Return base_url from the first available source."""
    oc = _load_opencode_config()
    if oc.get("base_url"):
        return oc["base_url"].strip()
    url = os.environ.get("OPENCODE_BASE_URL", "")
    if url:
        return url.strip()
    cfg = _load_vendavis_config()
    url = cfg.get("base_url", "").strip()
    if url:
        return url
    legacy = _load_legacy_config()
    url = legacy.get("base_url", "").strip()
    if url:
        return url
    # OpenCode Console personal API keys (oc_sk_…) only work on OpenCode's gateway
    try:
        if _load_api_key().startswith("oc_sk_"):
            return OPENCODE_GATEWAY_URL
    except RuntimeError:
        pass
    return ""


def _load_model() -> str:
    """Return model from the first available source."""
    oc = _load_opencode_config()
    if oc.get("model"):
        return oc["model"].strip()
    model = os.environ.get("OPENCODE_MODEL", "")
    if model:
        return model.strip()
    cfg = _load_vendavis_config()
    return cfg.get("model", "").strip() or DEFAULT_MODEL


class AIClient:
    def __init__(self):
        self._client: Optional[openai.OpenAI] = None  # lazy — recreated when config changes

    def _get_client(self, force_refresh: bool = False) -> openai.OpenAI:
        if self._client is None or force_refresh:
            base_url = _load_base_url() or None
            kwargs: dict = {"api_key": _load_api_key()}
            if base_url:
                kwargs["base_url"] = base_url
            self._client = openai.OpenAI(**kwargs)
        return self._client

    def _model(self) -> str:
        return _load_model()

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
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)
        resp = self._get_client().chat.completions.create(
            model=model or self._model(),
            max_tokens=max_tokens,
            messages=full_messages,
        )
        return resp.choices[0].message.content or ""

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
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)
        with self._get_client().chat.completions.create(
            model=model or self._model(),
            max_tokens=max_tokens,
            messages=full_messages,
            stream=True,
        ) as stream:
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
