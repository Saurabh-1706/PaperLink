"""Deterministic extraction core: bytes -> IR-JSON (+ rendered page images).

No LLM, no LangGraph. This is where every coordinate in the system originates.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.ai.ocr.base import OCREngine
from app.ai.ocr.factory import get_ocr_engine
from app.core.config import settings
from app.core.logging import get_logger
from app.modules.documents import pdf as pdf_module
from app.modules.extraction.ir import normalize_bbox, safe_normalize
from app.modules.extraction.preprocess import preprocess_for_ocr
from app.modules.extraction.reading_order import order_boxes
from app.schemas.common import BBox, BlockType, ExtractionMethod, PageClassification
from app.schemas.ir import IRBlock, IRDocument, IRPage

log = get_logger(__name__)


@dataclass
class PageArtifact:
    """A rendered page image kept alongside the IR so callers can persist it."""

    page_number: int
    image_bytes: bytes
    width: float
    height: float
    dpi: int


@dataclass
class ExtractionOutput:
    ir: IRDocument
    markdown: str
    artifacts: list[PageArtifact] = field(default_factory=list)


def extract_document(
    data: bytes,
    document_id: str,
    kind: str,
    ocr_engine: OCREngine | None = None,
    dpi: int | None = None,
    handwriting: bool = False,
) -> ExtractionOutput:
    from app.modules.extraction.markdown import document_to_markdown

    engine = ocr_engine or get_ocr_engine()
    pages: list[IRPage] = []
    artifacts: list[PageArtifact] = []

    for render in pdf_module.render_pages(data, dpi=dpi):
        if render.classification == PageClassification.SEARCHABLE:
            blocks = _native_blocks(render)
            method = ExtractionMethod.TEXT
        else:
            blocks = _ocr_blocks(render, engine, handwriting=handwriting)
            method = ExtractionMethod.OCR

        blocks = _assign_reading_order(blocks)
        pages.append(
            IRPage(
                page_number=render.page_number,
                width=render.width,
                height=render.height,
                dpi=render.dpi,
                classification=render.classification,
                extraction_method=method,
                blocks=blocks,
            )
        )
        artifacts.append(
            PageArtifact(
                page_number=render.page_number,
                image_bytes=render.image_bytes,
                width=render.width,
                height=render.height,
                dpi=render.dpi,
            )
        )

    ir = IRDocument(document_id=document_id, kind=kind, page_count=len(pages), pages=pages)
    return ExtractionOutput(ir=ir, markdown=document_to_markdown(ir), artifacts=artifacts)


def _native_blocks(render: pdf_module.PageRender) -> list[IRBlock]:
    blocks: list[IRBlock] = []
    for index, (text, box) in enumerate(pdf_module.group_words_into_lines(render.native_words)):
        bbox = safe_normalize(box, render.width, render.height)
        if bbox is None:
            continue
        blocks.append(
            IRBlock(
                block_id=f"p{render.page_number}-b{index}",
                text=text,
                bbox=bbox,
                confidence=1.0,
                block_type=BlockType.LINE,
                reading_order=index,
            )
        )
    return blocks


def _ocr_blocks(
    render: pdf_module.PageRender, engine: OCREngine, handwriting: bool
) -> list[IRBlock]:
    # Handwriting pages get a slightly larger working resolution; deskew always runs.
    target_long_edge = 2600 if handwriting else 2000
    preprocessed = preprocess_for_ocr(render.image_bytes, target_long_edge=target_long_edge)
    words = engine.run(preprocessed.image_bytes)

    # OCR boxes are in preprocessed-image space. Invert the recorded transform chain to
    # get back to rendered-image space, then scale to original page space before
    # normalising. Storing a preprocessed-space coordinate is the classic silent bug.
    scale_x = render.width / render.image_width if render.image_width else 1.0
    scale_y = render.height / render.image_height if render.image_height else 1.0

    placed: list[tuple[BBox, str, float]] = []
    for word in words:
        original_px = preprocessed.chain.to_original((word.x1, word.y1, word.x2, word.y2))
        page_space = (
            original_px[0] * scale_x,
            original_px[1] * scale_y,
            original_px[2] * scale_x,
            original_px[3] * scale_y,
        )
        bbox = safe_normalize(page_space, render.width, render.height)
        if bbox is None:
            log.debug("dropping degenerate OCR box", extra={"page": render.page_number})
            continue
        placed.append((bbox, word.text, max(0.0, min(1.0, float(word.confidence)))))

    blocks: list[IRBlock] = []
    for index, (bbox, text, confidence) in enumerate(group_ocr_words_into_lines(placed)):
        blocks.append(
            IRBlock(
                block_id=f"p{render.page_number}-o{index}",
                text=text,
                bbox=bbox,
                confidence=confidence,
                block_type=BlockType.LINE,
                reading_order=index,
                # Flagged, never dropped: dropping low-confidence blocks loses handwriting.
                low_confidence=confidence < settings.block_confidence_threshold,
            )
        )
    return blocks


# Two fragments belong to the same line when their vertical spans overlap by at least
# this fraction of the shorter one.
LINE_OVERLAP_RATIO = 0.45
# A horizontal gap this wide (normalised) is a column break, not a word space: it keeps
# a right-hand marks column, or the two halves of a comparison table, apart.
COLUMN_GAP = 0.09


def group_ocr_words_into_lines(
    placed: list[tuple[BBox, str, float]],
) -> list[tuple[BBox, str, float]]:
    """Cluster detector fragments into text lines. Pure geometry — no model involved.

    A detector emits word-sized boxes in its own order. Left as-is they defeat every
    downstream stage that reasons about lines: reading order interleaves them, answer
    segmentation sees a gap between every word, and the vision provider gets crops too
    small to read. Grouping is deterministic and reversible — the union of the
    fragments' boxes is still an OCR-derived coordinate (ADR-001).
    """
    if not placed:
        return []

    rows: list[list[tuple[BBox, str, float]]] = []
    for item in sorted(placed, key=lambda entry: (entry[0].y1 + entry[0].y2) / 2):
        bbox = item[0]
        for row in rows:
            top = min(b.y1 for b, _, _ in row)
            bottom = max(b.y2 for b, _, _ in row)
            overlap = min(bottom, bbox.y2) - max(top, bbox.y1)
            shorter = min(bottom - top, bbox.y2 - bbox.y1)
            if shorter > 0 and overlap / shorter >= LINE_OVERLAP_RATIO:
                row.append(item)
                break
        else:
            rows.append([item])

    out: list[tuple[BBox, str, float]] = []
    for row in rows:
        run: list[tuple[BBox, str, float]] = []
        for item in sorted(row, key=lambda entry: entry[0].x1):
            if run and item[0].x1 - max(b.x2 for b, _, _ in run) > COLUMN_GAP:
                out.append(_merge_run(run))
                run = []
            run.append(item)
        if run:
            out.append(_merge_run(run))
    return sorted(out, key=lambda entry: (entry[0].y1, entry[0].x1))


def _merge_run(run: list[tuple[BBox, str, float]]) -> tuple[BBox, str, float]:
    text = " ".join(item[1].strip() for item in run if item[1].strip())
    box = BBox(
        x1=min(item[0].x1 for item in run),
        y1=min(item[0].y1 for item in run),
        x2=max(item[0].x2 for item in run),
        y2=max(item[0].y2 for item in run),
    )
    # The line is only as trustworthy as its weakest fragment.
    return box, text, round(min(item[2] for item in run), 4)


def _assign_reading_order(blocks: list[IRBlock]) -> list[IRBlock]:
    boxes: list[BBox] = [block.bbox for block in blocks]
    ordered_indices = order_boxes(boxes)
    ordered: list[IRBlock] = []
    for position, index in enumerate(ordered_indices):
        block = blocks[index]
        ordered.append(block.model_copy(update={"reading_order": position}))
    return ordered


__all__ = ["ExtractionOutput", "PageArtifact", "extract_document", "normalize_bbox"]
