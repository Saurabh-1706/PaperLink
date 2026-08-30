"""The Intermediate Representation — the single source of truth downstream.

Document -> Page -> Block. Both pipelines consume IR-JSON and nothing else, which is
what makes them testable with no database, no network and no models.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.common import (
    BBox,
    BlockType,
    ExtractionMethod,
    PageClassification,
    ScriptClass,
)


class IRBlock(BaseModel):
    block_id: str
    text: str
    bbox: BBox
    confidence: float = Field(ge=0.0, le=1.0)
    block_type: BlockType = BlockType.LINE
    reading_order: int = Field(ge=0)
    low_confidence: bool = False
    # Routing hint from the deterministic line classifier. UNCERTAIN is the honest
    # default: a block extracted from native PDF text was never classified at all.
    script: ScriptClass = ScriptClass.UNCERTAIN
    # Raw classifier score in [0,1], 1.0 = most handwriting-like. Kept so the confusion
    # rate can be measured off stored IR without re-running extraction.
    script_score: float = Field(default=0.0, ge=0.0, le=1.0)
    # Set when a LineRecognizer replaced the OCR text for this block.
    recognizer: str | None = None


class IRPage(BaseModel):
    page_number: int = Field(ge=1)
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    dpi: int = Field(gt=0)
    classification: PageClassification
    extraction_method: ExtractionMethod
    rendered_image_uri: str | None = None
    blocks: list[IRBlock] = Field(default_factory=list)

    def block_by_id(self, block_id: str) -> IRBlock | None:
        return next((b for b in self.blocks if b.block_id == block_id), None)


class IRDocument(BaseModel):
    document_id: str
    kind: str
    page_count: int = Field(ge=0)
    pages: list[IRPage] = Field(default_factory=list)

    def ordered_blocks(self) -> list[tuple[int, IRBlock]]:
        """(page_number, block) across the whole document in reading order."""
        out: list[tuple[int, IRBlock]] = []
        for page in sorted(self.pages, key=lambda p: p.page_number):
            for block in sorted(page.blocks, key=lambda b: b.reading_order):
                out.append((page.page_number, block))
        return out

    def page(self, number: int) -> IRPage | None:
        return next((p for p in self.pages if p.page_number == number), None)
