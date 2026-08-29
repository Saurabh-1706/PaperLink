"""Structured outputs of the three independent pipelines and of grading."""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.common import ExtractionMethod, MappingType, Region, ReviewStatus


# --------------------------------------------------------------------------- questions
class ExtractedQuestion(BaseModel):
    question_id: str
    display_number: str          # verbatim as printed: "11 (a)"
    normalized_number: str       # sortable canonical form: "11.a"
    parent_number: str | None = None   # normalized_number of the parent, if nested
    text: str
    pages: list[int] = Field(default_factory=list)
    regions: list[Region] = Field(default_factory=list)
    order_index: int
    optional: bool = False
    max_marks: float | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    block_ids: list[str] = Field(default_factory=list)


class QuestionPipelineResult(BaseModel):
    questions: list[ExtractedQuestion] = Field(default_factory=list)
    ambiguities: list[str] = Field(default_factory=list)
    orphan_block_ids: list[str] = Field(default_factory=list)
    used_llm: bool = False


# ----------------------------------------------------------------------------- answers
class ExtractedAnswer(BaseModel):
    answer_id: str
    raw_text: str
    normalized_text: str
    detected_label: str | None = None       # normalized form of a label the student wrote
    detected_label_display: str | None = None
    page_numbers: list[int] = Field(default_factory=list)
    regions: list[Region] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    extraction_method: ExtractionMethod = ExtractionMethod.OCR
    is_continuation_of: str | None = None
    block_ids: list[str] = Field(default_factory=list)


class AnswerPipelineResult(BaseModel):
    answers: list[ExtractedAnswer] = Field(default_factory=list)
    low_confidence_answer_ids: list[str] = Field(default_factory=list)
    used_llm: bool = False


# ---------------------------------------------------------------------------- mappings
class MappingEvidence(BaseModel):
    """What makes a low-confidence mapping reviewable rather than merely doubtful."""

    stage: str
    label_score: float = 0.0
    spatial_score: float = 0.0
    semantic_score: float = 0.0
    combined_score: float = 0.0
    runner_up_score: float | None = None
    runner_up_question_id: str | None = None
    llm_verdict: str | None = None
    notes: list[str] = Field(default_factory=list)


class Mapping(BaseModel):
    question_id: str | None = None
    answer_id: str | None = None
    mapping_type: MappingType
    confidence: float = Field(ge=0.0, le=1.0)
    review_status: ReviewStatus
    regions: list[Region] = Field(default_factory=list)
    evidence: MappingEvidence


class MappingResult(BaseModel):
    mappings: list[Mapping] = Field(default_factory=list)
    used_llm: bool = False


# ----------------------------------------------------------------------------- grading
class RubricCriterion(BaseModel):
    name: str
    weight: float = 1.0
    keywords: list[str] = Field(default_factory=list)
    max_marks: float | None = None


class Rubric(BaseModel):
    criteria: list[RubricCriterion] = Field(default_factory=list)


class CriterionScore(BaseModel):
    name: str
    awarded: float
    max_marks: float
    rationale: str = ""


class Grade(BaseModel):
    question_id: str | None
    answer_id: str | None
    score: float
    max_score: float
    breakdown: list[CriterionScore] = Field(default_factory=list)
    feedback: str = ""
    method: str = "deterministic"   # deterministic | llm | skipped
    skipped_reason: str | None = None
