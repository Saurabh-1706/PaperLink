"""Provider selection is config (ADR-004). Tests inject through `set_provider`."""
from __future__ import annotations

from app.ai.llm.base import DocumentVisionProvider, LLMProvider
from app.ai.llm.null import NullLLMProvider
from app.core.config import settings

_override: object | None = None


def set_provider(provider: object | None) -> None:
    global _override
    _override = provider


def _build() -> object:
    if _override is not None:
        return _override
    if settings.llm_provider == "gemini" and settings.gemini_api_key:
        from app.ai.llm.gemini import GeminiProvider

        return GeminiProvider()
    return NullLLMProvider()


def get_llm_provider() -> LLMProvider:
    return _build()  # type: ignore[return-value]


def get_vision_provider() -> DocumentVisionProvider:
    return _build()  # type: ignore[return-value]
