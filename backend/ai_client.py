"""
OpenCode AI client — provider-agnostic, OpenAI-compatible API.

Supports any provider that exposes an OpenAI-compatible chat completions
endpoint (OpenAI, Anthropic via compat layer, Azure OpenAI, local Ollama,
custom gateways, etc.).

Config priority (highest → lowest):
  1. opencode.config.json  in project root (developer override)
  2. OPENCODE_API_KEY / OPENCODE_BASE_URL / OPENCODE_MODEL env vars
  3. ~/.avio_api_key   (written by Avio Settings modal)
  4. ~/.avio_config.json  model / base_url fields
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

CONFIG_PATH      = Path.home() / ".avio_config.json"
API_KEY_PATH     = Path.home() / ".avio_api_key"
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


def _load_avio_config() -> dict:
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


def save_config(
    model:          str  = "",
    base_url:       str  = "",
    theme:          Optional[str]  = None,
    skills_enabled: Optional[bool] = None,
    skills_source:  Optional[str]  = None,
    skills_path:    Optional[str]  = None,
    skills_url:     Optional[str]  = None,
    custom_skills:  Optional[list] = None,
) -> None:
    """Merge model/base_url/theme/skills settings into ~/.avio_config.json."""
    cfg = _load_avio_config()
    if model:
        cfg["model"] = model
    if base_url is not None:
        cfg["base_url"] = base_url
    if theme is not None:
        cfg["theme"] = theme
    if skills_enabled is not None:
        cfg["skills_enabled"] = skills_enabled
    if skills_source is not None:
        cfg["skills_source"] = skills_source
    if skills_path is not None:
        cfg["skills_path"] = skills_path
    if skills_url is not None:
        cfg["skills_url"] = skills_url
    if custom_skills is not None:
        cfg["custom_skills"] = custom_skills
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
    # 3. ~/.avio_api_key
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
        "add it to opencode.config.json, write it to ~/.avio_api_key, "
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
    cfg = _load_avio_config()
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
    cfg = _load_avio_config()
    return cfg.get("model", "").strip() or DEFAULT_MODEL


# Presets shown in Settings. Every one speaks the OpenAI-compatible API
# (chat/completions + /models); Azure OpenAI is not included because it needs
# per-deployment URLs and an api-version.
PROVIDER_PRESETS = [
    {"id": "opencode",   "label": "OpenCode (Console gateway)",       "base_url": OPENCODE_GATEWAY_URL,                                       "key_hint": "oc_sk_…"},
    {"id": "openai",     "label": "OpenAI (ChatGPT models)",          "base_url": "https://api.openai.com/v1",                                "key_hint": "sk-…"},
    {"id": "anthropic",  "label": "Anthropic (Claude)",               "base_url": "https://api.anthropic.com/v1",                             "key_hint": "sk-ant-…"},
    {"id": "google",     "label": "Google (Gemini)",                  "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",  "key_hint": "AIza…"},
    {"id": "openrouter", "label": "OpenRouter (Llama and many more)", "base_url": "https://openrouter.ai/api/v1",                             "key_hint": "sk-or-…"},
    {"id": "groq",       "label": "Groq (Llama, fast)",               "base_url": "https://api.groq.com/openai/v1",                           "key_hint": "gsk_…"},
    {"id": "ollama",     "label": "Ollama (local Llama)",             "base_url": "http://localhost:11434/v1",                                "key_hint": "not needed", "needs_key": False},
    {"id": "custom",     "label": "Custom gateway",                   "base_url": "",                                                         "key_hint": "your gateway key"},
]

_NON_CHAT_HINTS = ("embed", "whisper", "tts", "dall-e", "moderation", "davinci", "babbage",
                   "transcribe", "realtime", "rerank", "image", "audio")


def _is_local(url: str) -> bool:
    return any(h in (url or "") for h in ("localhost", "127.0.0.1", "[::1]"))


def _client_kwargs(api_key: str, url: str) -> dict:
    """Constructor kwargs for openai.OpenAI, with per-vendor quirks applied."""
    key = (api_key or "").strip()
    if not key:
        if _is_local(url):
            key = "not-needed"   # Ollama / LM Studio ignore the key but the SDK requires one
        else:
            key = _load_api_key()   # raises a helpful error if none is configured
    kwargs: dict = {"api_key": key}
    if url:
        kwargs["base_url"] = url
    if "anthropic.com" in url:
        # Anthropic's /models endpoint rejects requests without a version header
        kwargs["default_headers"] = {"anthropic-version": "2023-06-01"}
    return kwargs


def needs_key(url: str) -> bool:
    return not _is_local(url)


def fetch_models(api_key: Optional[str] = None, base_url: Optional[str] = None) -> list[str]:
    """List chat-capable model ids from the provider's OpenAI-compatible /models endpoint.

    Pass api_key/base_url to test unsaved Settings values; otherwise the saved
    config is used. Raises on failure so the caller can fall back.
    """
    url = (base_url or "").strip() or _load_base_url()
    # Don't mix a typed-in URL with a different vendor's saved key by accident: a blank
    # key falls back to the saved one, which is the normal "just refresh" case.
    kwargs = _client_kwargs((api_key or "").strip(), url)
    kwargs.update(timeout=10.0, max_retries=0)
    page = openai.OpenAI(**kwargs).models.list()
    ids = []
    for m in page.data:
        mid = m.id.removeprefix("models/")   # Gemini prefixes ids with "models/"
        if not any(h in mid.lower() for h in _NON_CHAT_HINTS):
            ids.append(mid)
    if "anthropic.com" not in url:
        ids.sort(key=str.lower)   # Anthropic already returns newest first
    return ids


class AIClient:
    def __init__(self):
        self._client: Optional[openai.OpenAI] = None  # lazy — recreated when config changes

    def _get_client(self, force_refresh: bool = False) -> openai.OpenAI:
        if self._client is None or force_refresh:
            self._client = openai.OpenAI(**_client_kwargs("", _load_base_url()))
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
