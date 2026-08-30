"""Deterministic extraction core: bytes -> IR-JSON (+ rendered page images).

No LLM, no LangGraph. This is where every coordinate in the system originates.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from app.ai.ocr.base import OCREngine
from app.ai.ocr.factory import get_line_recognizer, get_ocr_engine
from app.core.config import settings
from app.core.logging import get_logger
from app.modules.documents import pdf as pdf_module
from app.modules.extraction.ir import normalize_bbox, safe_normalize
from app.modules.extraction.preprocess import preprocess_for_ocr
from app.modules.extraction.reading_order import order_boxes
from app.modules.extraction.script_classifier import ScriptVerdict, classify_line
from app.schemas.common import (
    BBox,
    BlockType,
    ExtractionMethod,
    PageClassification,
    ScriptClass,
)
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
    log.info("extraction started", extra={"document_id": document_id, "kind": kind, "engine": engine.name, "handwriting": handwriting})
    renders = pdf_module.render_pages(data, dpi=dpi)

    def _process_page(render: pdf_module.PageRender) -> tuple[IRPage, PageArtifact]:
        if render.classification == PageClassification.SEARCHABLE:
            blocks = _native_blocks(render)
            method = ExtractionMethod.TEXT
        else:
            blocks = _ocr_blocks(render, engine, handwriting=handwriting)
            method = ExtractionMethod.OCR
        log.info(
            "page extracted",
            extra={"document_id": document_id, "page": render.page_number, "method": str(method), "blocks": len(blocks)},
        )
        blocks = _assign_reading_order(blocks)
        ir_page = IRPage(
            page_number=render.page_number,
            width=render.width,
            height=render.height,
            dpi=render.dpi,
            classification=render.classification,
            extraction_method=method,
            blocks=blocks,
        )
        artifact = PageArtifact(
            page_number=render.page_number,
            image_bytes=render.image_bytes,
            width=render.width,
            height=render.height,
            dpi=render.dpi,
        )
        return ir_page, artifact

    results: list[tuple[IRPage, PageArtifact]] = [None] * len(renders)  # type: ignore[list-item]
    with ThreadPoolExecutor(max_workers=min(4, len(renders))) as pool:
        futures = {pool.submit(_process_page, r): r.page_number - 1 for r in renders}
        for future in as_completed(futures):
            results[futures[future]] = future.result()

    pages = [r[0] for r in results]
    artifacts = [r[1] for r in results]
    log.info("extraction complete", extra={"document_id": document_id, "kind": kind, "pages": len(pages)})
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


# 1800px is the empirical sweet spot for RapidOCR on handwriting: same word count and
# high-confidence rate as 2600px but ~32% faster. Printed pages need less.
HANDWRITING_LONG_EDGE = 1800
PRINTED_LONG_EDGE = 1600


def ocr_target_long_edge(handwriting: bool) -> int:
    """The image size OCR runs at. Exported because anything that places coordinates in
    preprocessed-image space -- the eval harness, any probe -- has to use the same value
    or the inverted transform chain lands every bbox off its text."""
    return HANDWRITING_LONG_EDGE if handwriting else PRINTED_LONG_EDGE


def _ocr_blocks(
    render: pdf_module.PageRender, engine: OCREngine, handwriting: bool
) -> list[IRBlock]:
    # Deskew only runs on handwriting -- printed PDFs rendered by PyMuPDF are already
    # axis-aligned so the skew search is pure waste on them.
    preprocessed = preprocess_for_ocr(
        render.image_bytes,
        target_long_edge=ocr_target_long_edge(handwriting),
        deskew=handwriting,
    )
    words = engine.run(preprocessed.image_bytes)

    # OCR boxes are in preprocessed-image space. Invert the recorded transform chain to
    # get back to rendered-image space, then scale to original page space before
    # normalising. Storing a preprocessed-space coordinate is the classic silent bug.
    scale_x = render.width / render.image_width if render.image_width else 1.0
    scale_y = render.height / render.image_height if render.image_height else 1.0

    fragments: list[_Fragment] = []
    for word in words:
        pre_box = (word.x1, word.y1, word.x2, word.y2)
        original_px = preprocessed.chain.to_original(pre_box)
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
        fragments.append(
            _Fragment(
                bbox=bbox,
                pre_box=pre_box,
                text=word.text,
                confidence=max(0.0, min(1.0, float(word.confidence))),
            )
        )

    lines = [(_merge_run(run), run) for run in _group_fragments(fragments)]
    lines.sort(key=lambda entry: (entry[0][0].y1, entry[0][0].x1))

    runs = [run for _, run in lines]
    merged = [entry for entry, _ in lines]
    verdicts = _classify_runs(runs)
    replacements = _recognize_handwriting(
        runs, verdicts, merged, preprocessed.image_bytes, render.page_number
    )

    blocks: list[IRBlock] = []
    for index, (bbox, text, confidence) in enumerate(merged):
        recognizer_name: str | None = None
        replacement = replacements.get(index)
        if replacement is not None:
            text, confidence, recognizer_name = replacement
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
                script=verdicts[index].script,
                script_score=verdicts[index].score,
                recognizer=recognizer_name,
            )
        )
    return blocks


def _classify_runs(runs: list[_Fragment]) -> list[ScriptVerdict]:
    """Score every line on the page. Telemetry-only unless LINE_SCRIPT_MODE=route.

    Ships as logging first by design: a misrouted line would send printed text to a
    handwriting recogniser, so the confusion rate is measured off stored IR before any
    behaviour depends on the verdict.
    """
    if settings.line_script_mode == "off":
        return [ScriptVerdict(ScriptClass.UNCERTAIN, 0.0, {}) for _ in runs]

    verdicts = [
        classify_line(
            [fragment.bbox for fragment in run],
            [fragment.text for fragment in run],
            [fragment.confidence for fragment in run],
            settings.line_script_handwriting_threshold,
        )
        for run in runs
    ]
    counts: dict[str, int] = {}
    for verdict in verdicts:
        counts[str(verdict.script)] = counts.get(str(verdict.script), 0) + 1
    log.info("line script classified", extra={"counts": counts, "lines": len(runs)})
    return verdicts


def _recognize_handwriting(
    runs: list[list[_Fragment]],
    verdicts: list[ScriptVerdict],
    merged: list[tuple[BBox, str, float]],
    preprocessed_image: bytes,
    page_number: int,
) -> dict[int, tuple[str, float, str]]:
    """Re-read handwritten lines with a LineRecognizer. Returns {line index: replacement}.

    Crops come from the PREPROCESSED image, which is the space the detector's boxes are
    already in, so no coordinate is produced, revised or stored here (ADR-001). One
    batched call per page: a one-at-a-time recogniser is a latency bug.
    """
    if settings.line_script_mode != "route":
        return {}
    recognizer = get_line_recognizer()
    if recognizer is None:
        return {}

    candidates = [
        index
        for index, verdict in enumerate(verdicts)
        if verdict.script == ScriptClass.HANDWRITTEN
        and merged[index][2] < settings.trocr_high_confidence_floor
    ]
    if not candidates:
        return {}

    try:
        crops = [_crop_preprocessed(preprocessed_image, runs[index]) for index in candidates]
        results = recognizer.read(crops)
    except Exception as exc:  # noqa: BLE001
        # No pipeline may *require* a model to produce a result: the OCR text stands.
        log.warning(
            "line recognizer failed",
            extra={"page": page_number, "recognizer": recognizer.name, "error": str(exc)},
        )
        return {}

    from app.ai.ocr.trocr import should_replace

    out: dict[int, tuple[str, float, str]] = {}
    for index, candidate in zip(candidates, results):
        _bbox, ocr_text, ocr_confidence = merged[index]
        if should_replace(
            candidate, ocr_text, ocr_confidence, settings.trocr_high_confidence_floor
        ):
            out[index] = (candidate.text.strip(), candidate.confidence, recognizer.name)
    log.info(
        "handwriting re-read",
        extra={"page": page_number, "candidates": len(candidates), "replaced": len(out)},
    )
    return out


_CROP_PADDING_PX = 4


def _crop_preprocessed(image_bytes: bytes, run: list[_Fragment]) -> bytes:
    """Cut one line out of the preprocessed page image, the space the boxes live in."""
    import io

    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes))
    box = (
        max(0, int(min(f.pre_box[0] for f in run)) - _CROP_PADDING_PX),
        max(0, int(min(f.pre_box[1] for f in run)) - _CROP_PADDING_PX),
        min(image.width, int(max(f.pre_box[2] for f in run)) + _CROP_PADDING_PX),
        min(image.height, int(max(f.pre_box[3] for f in run)) + _CROP_PADDING_PX),
    )
    buffer = io.BytesIO()
    image.crop(box).convert("RGB").save(buffer, format="PNG")
    return buffer.getvalue()


# Two fragments belong to the same line when their vertical spans overlap by at least
# this fraction of the shorter one.
LINE_OVERLAP_RATIO = 0.45
# A horizontal gap this wide (normalised) is a column break, not a word space: it keeps
# a right-hand marks column, or the two halves of a comparison table, apart.
COLUMN_GAP = 0.09


@dataclass(frozen=True)
class _Fragment:
    """One detector box, carrying both coordinate spaces it is needed in.

    `bbox` is normalised original-page space and is what reaches the IR. `pre_box` is
    preprocessed-image pixels, used only to cut a crop out of the image the detector
    actually saw. Keeping them together is what lets a line be re-read by a model
    without ever round-tripping a coordinate through one.
    """

    bbox: BBox
    pre_box: tuple[float, float, float, float]
    text: str
    confidence: float


def _group_fragments(fragments: list[_Fragment]) -> list[list[_Fragment]]:
    """Cluster detector fragments into text lines. Pure geometry -- no model involved.

    A detector emits word-sized boxes in its own order. Left as-is they defeat every
    downstream stage that reasons about lines: reading order interleaves them, answer
    segmentation sees a gap between every word, and the vision provider gets crops too
    small to read. Grouping is deterministic and reversible -- the union of the
    fragments' boxes is still an OCR-derived coordinate (ADR-001).
    """
    if not fragments:
        return []

    rows: list[list[_Fragment]] = []
    for fragment in sorted(fragments, key=lambda f: (f.bbox.y1 + f.bbox.y2) / 2):
        bbox = fragment.bbox
        for row in rows:
            top = min(f.bbox.y1 for f in row)
            bottom = max(f.bbox.y2 for f in row)
            overlap = min(bottom, bbox.y2) - max(top, bbox.y1)
            shorter = min(bottom - top, bbox.y2 - bbox.y1)
            if shorter > 0 and overlap / shorter >= LINE_OVERLAP_RATIO:
                row.append(fragment)
                break
        else:
            rows.append([fragment])

    out: list[list[_Fragment]] = []
    for row in rows:
        run: list[_Fragment] = []
        for fragment in sorted(row, key=lambda f: f.bbox.x1):
            if run and fragment.bbox.x1 - max(f.bbox.x2 for f in run) > COLUMN_GAP:
                out.append(run)
                run = []
            run.append(fragment)
        if run:
            out.append(run)
    return out


def group_ocr_words_into_lines(
    placed: list[tuple[BBox, str, float]],
) -> list[tuple[BBox, str, float]]:
    """Tuple-in / tuple-out grouping, for callers with no preprocessed image to crop."""
    fragments = [
        _Fragment(bbox=bbox, pre_box=(0.0, 0.0, 0.0, 0.0), text=text, confidence=confidence)
        for bbox, text, confidence in placed
    ]
    merged = [_merge_run(run) for run in _group_fragments(fragments)]
    return sorted(merged, key=lambda entry: (entry[0].y1, entry[0].x1))


def _merge_run(run: list[_Fragment]) -> tuple[BBox, str, float]:
    text = " ".join(fragment.text.strip() for fragment in run if fragment.text.strip())
    box = BBox(
        x1=min(fragment.bbox.x1 for fragment in run),
        y1=min(fragment.bbox.y1 for fragment in run),
        x2=max(fragment.bbox.x2 for fragment in run),
        y2=max(fragment.bbox.y2 for fragment in run),
    )
    # The line is only as trustworthy as its weakest fragment.
    return box, text, round(min(fragment.confidence for fragment in run), 4)


def _assign_reading_order(blocks: list[IRBlock]) -> list[IRBlock]:
    boxes: list[BBox] = [block.bbox for block in blocks]
    ordered_indices = order_boxes(boxes)
    ordered: list[IRBlock] = []
    for position, index in enumerate(ordered_indices):
        block = blocks[index]
        ordered.append(block.model_copy(update={"reading_order": position}))
    return ordered


__all__ = [
    "ExtractionOutput",
    "PageArtifact",
    "extract_document",
    "normalize_bbox",
    "ocr_target_long_edge",
]
