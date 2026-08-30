"""LLM / vision interfaces.

Every method may return None, and every caller must have a deterministic fallback:
no pipeline is allowed to require an LLM to produce a result (docs/01-architecture.md).
Vision methods take block ids and return block ids — never coordinates (ADR-001).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LLMUsage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    detail: list[str] = field(default_factory=list)


class LLMProvider(ABC):
    name = "abstract"

    def __init__(self) -> None:
        self.usage = LLMUsage()

    @abstractmethod
    def complete_json(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        """Return structured JSON matching `schema`, or None on any failure."""


class DocumentVisionProvider(ABC):
    name = "abstract"

    def __init__(self) -> None:
        self.usage = LLMUsage()

    @abstractmethod
    def transcribe(self, image_bytes: bytes, ocr_text: str) -> str | None:
        """Return a corrected transcription of a cropped region, or None."""

    def transcribe_page(
        self,
        image_bytes: bytes,
        ocr_lines: list[str],
        confidences: list[float] | None = None,
    ) -> list[str] | None:
        """Correct all OCR lines on a full page in one call.

        `confidences` is a parallel list of OCR confidence scores (0-1) for each line.
        Providers use it to annotate which lines need the most attention in the prompt.
        Returns a list of corrected strings in the same order as `ocr_lines`, or None
        on failure. Default implementation falls back to per-line transcribe() calls so
        providers that don't override still work correctly.
        """
        return None

    @abstractmethod
    def structure_blocks(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        """Reason about block ids; returns block ids, never coordinates."""


class EmbeddingProvider(ABC):
    name = "abstract"

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]] | None: ...
