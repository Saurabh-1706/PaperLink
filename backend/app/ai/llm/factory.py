"""Provider selection is config (ADR-004). Tests inject through `set_provider`."""
from __future__ import annotations

from app.ai.llm.base import DocumentVisionProvider, LLMProvider
from app.ai.llm.null import NullLLMProvider
from app.core.config import settings

_override: object | None = None


def set_provider(provider: object | None) -> None:
    global _override
    _override = provider


def _for(name: str) -> object:
    """Build the named provider, or the null provider when it is unusable.

    Missing credentials are not an error: the null provider makes every caller take
    its deterministic fallback, which is the required behaviour anyway.
    """
    if name == "gemini" and settings.gemini_api_key:
        from app.ai.llm.gemini import GeminiProvider

        return GeminiProvider()
    if name == "groq" and settings.groq_api_key:
        from app.ai.llm.groq import GroqProvider

        return GroqProvider()
    return NullLLMProvider()


def get_llm_provider() -> LLMProvider:
    if _override is not None:
        return _override  # type: ignore[return-value]
    return _for(settings.llm_provider)  # type: ignore[return-value]


def get_vision_provider() -> DocumentVisionProvider:
    if _override is not None:
        return _override  # type: ignore[return-value]
    name = settings.vision_provider
    if name == "auto":
        name = settings.llm_provider
    return _for(name)  # type: ignore[return-value]
