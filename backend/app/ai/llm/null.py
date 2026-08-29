"""No-op provider. Selected when no credentials are configured; every call returns
None so callers exercise their deterministic fallback."""
from __future__ import annotations

from typing import Any

from app.ai.llm.base import DocumentVisionProvider, LLMProvider


class NullLLMProvider(LLMProvider, DocumentVisionProvider):
    name = "null"

    def complete_json(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        return None

    def transcribe(self, image_bytes: bytes, ocr_text: str) -> str | None:
        return None

    def structure_blocks(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        return None
