"""Documents, pages, blocks, questions, answers, mappings and grades.

`bbox` fields store the normalised [x1, y1, x2, y2] list — the coordinate contract
holds at the storage layer too (docs/03-coordinate-contract.md).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

from app.db.base import OrgOwned


@dataclass
class Document(OrgOwned):
    __collection__: ClassVar[str] = "documents"

    assessment_id: str = ""
    kind: str = ""
    storage_uri: str = ""
    page_count: int = 0
    mime: str = "application/pdf"
    checksum: str = ""
    classification: str | None = None
    markdown_uri: str | None = None
    ir_uri: str | None = None


@dataclass
class Page(OrgOwned):
    __collection__: ClassVar[str] = "pages"

    document_id: str = ""
    page_number: int = 0
    width: float = 0.0
    height: float = 0.0
    dpi: int = 0
    classification: str = ""
    extraction_method: str = ""
    rendered_image_uri: str | None = None


@dataclass
class Block(OrgOwned):
    __collection__: ClassVar[str] = "blocks"

    page_id: str = ""
    block_key: str = ""
    text: str = ""
    bbox: list[float] = field(default_factory=list)
    confidence: float = 1.0
    block_type: str = "line"
    reading_order: int = 0
    low_confidence: bool = False


@dataclass
class Question(OrgOwned):
    __collection__: ClassVar[str] = "questions"

    assessment_id: str = ""
    external_id: str = ""
    display_number: str = ""
    normalized_number: str = ""
    parent_id: str | None = None
    text: str = ""
    order_index: int = 0
    optional: bool = False
    max_marks: float | None = None
    confidence: float = 1.0


@dataclass
class QuestionRegion(OrgOwned):
    __collection__: ClassVar[str] = "question_regions"

    question_id: str = ""
    page_number: int = 0
    bbox: list[float] = field(default_factory=list)


@dataclass
class Answer(OrgOwned):
    __collection__: ClassVar[str] = "answers"

    assessment_id: str = ""
    external_id: str = ""
    raw_text: str = ""
    normalized_text: str = ""
    detected_label: str | None = None
    confidence: float = 1.0
    extraction_method: str = "ocr"
    is_continuation_of: str | None = None


@dataclass
class AnswerRegion(OrgOwned):
    __collection__: ClassVar[str] = "answer_regions"

    answer_id: str = ""
    page_number: int = 0
    bbox: list[float] = field(default_factory=list)


@dataclass
class MappingRow(OrgOwned):
    __collection__: ClassVar[str] = "mappings"

    assessment_id: str = ""
    question_id: str | None = None
    answer_id: str | None = None
    mapping_type: str = ""
    confidence: float = 0.0
    review_status: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class GradeRow(OrgOwned):
    __collection__: ClassVar[str] = "grades"

    mapping_id: str = ""
    score: float = 0.0
    max_score: float = 0.0
    rubric: dict[str, Any] = field(default_factory=dict)
    feedback: str = ""
    method: str = "deterministic"
