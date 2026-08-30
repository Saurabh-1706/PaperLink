"""Shared primitives. The bbox convention lives here and nowhere else.

docs/03-coordinate-contract.md: bbox = [x1, y1, x2, y2], normalised floats in [0, 1],
origin top-left, relative to the page's ORIGINAL dimensions.
"""
from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MIN_REGION_AREA = 1e-6


class DocumentKind(StrEnum):
    QUESTION_PAPER = "question_paper"
    ANSWER_SHEET = "answer_sheet"


class PageClassification(StrEnum):
    SEARCHABLE = "searchable"
    SCANNED = "scanned"
    IMAGE = "image"


class ExtractionMethod(StrEnum):
    TEXT = "text"
    OCR = "ocr"


class BlockType(StrEnum):
    LINE = "line"
    PARAGRAPH = "paragraph"
    WORD = "word"


class ScriptClass(StrEnum):
    """How a line was written, inferred from detector geometry alone.

    Not a layout model's output and not a coordinate: it is a routing hint, so a wrong
    value costs recognition quality, never bbox correctness (ADR-001).
    """

    PRINTED = "printed"
    HANDWRITTEN = "handwritten"
    UNCERTAIN = "uncertain"


class MappingType(StrEnum):
    DIRECT = "direct"
    SEMANTIC = "semantic"
    SPATIAL = "spatial"
    UNMATCHED = "unmatched"
    UNANSWERED = "unanswered"


class ReviewStatus(StrEnum):
    AUTO_ACCEPTED = "auto_accepted"
    NEEDS_REVIEW = "needs_review"
    HUMAN_CONFIRMED = "human_confirmed"
    HUMAN_CORRECTED = "human_corrected"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobStage(StrEnum):
    INGESTION = "ingestion"
    EXTRACTION = "extraction"
    QUESTION_EXTRACTION = "question_extraction"
    ANSWER_EXTRACTION = "answer_extraction"
    MAPPING = "mapping"
    GRADING = "grading"
    DONE = "done"


class BBox(BaseModel):
    """Normalised box. Degenerate boxes are a validation failure, not a stored value."""

    model_config = ConfigDict(frozen=True)

    x1: float = Field(ge=0.0, le=1.0)
    y1: float = Field(ge=0.0, le=1.0)
    x2: float = Field(ge=0.0, le=1.0)
    y2: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_ordering(self) -> BBox:
        if not (self.x1 < self.x2 and self.y1 < self.y2):
            raise ValueError(f"degenerate bbox: {self.as_list()}")
        if self.area < MIN_REGION_AREA:
            raise ValueError(f"bbox area below minimum threshold: {self.as_list()}")
        return self

    @property
    def area(self) -> float:
        return (self.x2 - self.x1) * (self.y2 - self.y1)

    def as_list(self) -> list[float]:
        return [self.x1, self.y1, self.x2, self.y2]

    @classmethod
    def from_list(cls, values: list[float] | tuple[float, float, float, float]) -> BBox:
        x1, y1, x2, y2 = values
        return cls(x1=x1, y1=y1, x2=x2, y2=y2)

    def union(self, other: BBox) -> BBox:
        return BBox(
            x1=min(self.x1, other.x1),
            y1=min(self.y1, other.y1),
            x2=max(self.x2, other.x2),
            y2=max(self.y2, other.y2),
        )

    def iou(self, other: BBox) -> float:
        ix1, iy1 = max(self.x1, other.x1), max(self.y1, other.y1)
        ix2, iy2 = min(self.x2, other.x2), min(self.y2, other.y2)
        if ix2 <= ix1 or iy2 <= iy1:
            return 0.0
        inter = (ix2 - ix1) * (iy2 - iy1)
        return inter / (self.area + other.area - inter)


def union_all(boxes: list[BBox]) -> BBox:
    if not boxes:
        raise ValueError("cannot union an empty box list")
    out = boxes[0]
    for box in boxes[1:]:
        out = out.union(box)
    return out


class Region(BaseModel):
    """A page-anchored box. Regions are always a list, even when there is one."""

    model_config = ConfigDict(frozen=True)

    page: int = Field(ge=1)
    bbox: BBox

    @field_validator("bbox", mode="before")
    @classmethod
    def _coerce(cls, value: object) -> object:
        if isinstance(value, (list, tuple)):
            return BBox.from_list(list(value))  # type: ignore[arg-type]
        return value
