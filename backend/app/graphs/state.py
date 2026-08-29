"""Graph state objects. LangGraph is used only where there is genuine state,
branching, retry or confidence-based routing (ADR-002)."""
from __future__ import annotations

from typing import Any, TypedDict

from app.schemas.ir import IRDocument
from app.schemas.pipeline import (
    AnswerPipelineResult,
    ExtractedAnswer,
    ExtractedQuestion,
    MappingResult,
    QuestionPipelineResult,
)


class QuestionGraphState(TypedDict, total=False):
    ir: IRDocument
    result: QuestionPipelineResult
    ambiguities: list[str]
    used_llm: bool
    provider: Any


class AnswerGraphState(TypedDict, total=False):
    ir: IRDocument
    result: AnswerPipelineResult
    page_images: dict[int, bytes]
    low_confidence_ids: list[str]
    used_llm: bool
    provider: Any


class MappingGraphState(TypedDict, total=False):
    questions: list[ExtractedQuestion]
    answers: list[ExtractedAnswer]
    result: MappingResult
    needs_llm: bool
    used_llm: bool
    provider: Any
    config: Any
