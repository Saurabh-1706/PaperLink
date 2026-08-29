"""HTTP request/response contracts."""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import Region


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class CreateAssessmentRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)


class AssessmentOut(BaseModel):
    id: str
    title: str
    status: str
    question_doc_id: str | None = None
    answer_doc_id: str | None = None


class JobOut(BaseModel):
    job_id: str
    assessment_id: str
    stage: str
    status: str
    progress: float
    error: str | None = None


class DocumentOut(BaseModel):
    document_id: str
    kind: str
    page_count: int
    classification: str | None
    created: bool
    job_id: str | None = None


class QuestionOut(BaseModel):
    id: str
    display_number: str
    normalized_number: str
    parent_id: str | None
    text: str
    order_index: int
    optional: bool
    max_marks: float | None
    confidence: float
    pages: list[int]
    regions: list[Region]


class AnswerOut(BaseModel):
    id: str
    raw_text: str
    normalized_text: str
    detected_label: str | None
    confidence: float
    extraction_method: str
    is_continuation_of: str | None
    pages: list[int]
    regions: list[Region]


class MappingOut(BaseModel):
    id: str
    question_id: str | None
    answer_id: str | None
    mapping_type: str
    confidence: float
    review_status: str
    evidence: dict
    regions: list[Region]


class MappingPatch(BaseModel):
    answer_id: str | None = None
    review_status: str | None = None


class ResultsOut(BaseModel):
    assessment_id: str
    mapping_count: int
    needs_review: int
    unanswered: int
    unmatched: int
    total_score: float
    max_score: float
    percentage: float


class GradeBreakdownOut(BaseModel):
    name: str
    awarded: float
    max_marks: float
    rationale: str = ""


class GradeOut(BaseModel):
    """One graded mapping. Keyed by `mapping_id` so a client joins it onto
    `MappingOut` without a second lookup."""

    id: str
    mapping_id: str
    score: float
    max_score: float
    breakdown: list[GradeBreakdownOut] = Field(default_factory=list)
    feedback: str = ""
    method: str
