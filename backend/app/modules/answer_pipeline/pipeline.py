"""Answer pipeline: IR-JSON in, structured answers out.

Structurally independent of the question pipeline — it never sees questions. Relating
the two is the mapping engine's job alone.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from app.core.config import settings
from app.modules.question_pipeline.labels import (
    ANSWER_PREFIX,
    ParsedLabel,
    normalize_parts,
    parse_label,
)
from app.schemas.common import ExtractionMethod, Region, union_all
from app.schemas.ir import IRBlock, IRDocument
from app.schemas.pipeline import AnswerPipelineResult, ExtractedAnswer

# Segmentation tuning. These are page-relative, so they survive any page size.
GAP_FACTOR = 2.5            # a gap this much larger than the page's line spacing starts a segment
MIN_GAP = 0.012
INDENT_SHIFT = 0.08         # a left-margin jump this large is a structural break
BOTTOM_OF_PAGE = 0.88       # a segment reaching below this may continue on the next page
TOP_OF_PAGE = 0.18
CONTINUATION_CUES = re.compile(r"\b(cont(?:d|inued)?\.?|p\.?t\.?o\.?)\b", re.IGNORECASE)

# U1 — Noise filters applied before segmentation.
# Lone digit/letter: page numbers, MCQ option markers.
_NOISE_LONE = re.compile(r"^\s*[\dA-Za-z]\s*$")
# Section headers: "SECTION-A", "SECTION - B", "SECTION D" etc.
_NOISE_SECTION = re.compile(r"^\s*SECTION\s*[-–]?\s*[A-Z]\s*$", re.IGNORECASE)
# MCQ option line: "1. (D) Some text" or "3. (A) ..." — printed, not handwritten.
_NOISE_MCQ = re.compile(r"^\s*\d{1,2}\.\s*\([A-Da-d]\)\s+\S")


# U8 — MCQ option letters are answers, not sub-part labels.
# On an answer sheet "8 (B) ..." is the student's chosen option for Q8, not sub-part b
# of Q8. `parse_label` cannot draw that distinction: it is shared verbatim with the
# question pipeline (labels.py:2), where "12 (a)" genuinely IS a sub-part. So the
# distinction is drawn here, on the answer side only, leaving question parsing untouched.
#
# The signal is CASE: option markers are uppercase (A)-(D); printed sub-parts are
# lowercase (a)-(h). These patterns are deliberately case-SENSITIVE — adding
# re.IGNORECASE would collapse the only thing telling the two apart.
_MCQ_NUMBERED = re.compile(r"^\s*(?:Q(?:ues(?:tion)?)?\s*\.?\s*)?(\d{1,3})\s*[\.\):]?\s*[\(\[]\s*[A-D]\s*[\)\]]")
_MCQ_BARE = re.compile(r"^\s*[\(\[]\s*[A-D]\s*[\)\]]")


def parse_answer_label(text: str) -> ParsedLabel | None:
    """`parse_label` for answer sheets, with MCQ option letters demoted.

    Two corrections over the shared parser:
      - "8 (B) ard m"  -> `8`, not `8.b`. The mapping engine looks up the normalised
        label directly, so `8.b` sends it hunting for a row that does not exist and the
        answer lands in `needs_review` instead of matching Q8.
      - "(B) 0.42"     -> None. An option letter with no question number attached is
        not a label at all; inventing `b` fabricates a top-level-free label that can
        never match. Returning None lets segmentation fall back to geometry.
    """
    parsed = parse_label(text, allow_answer_prefix=True)
    if parsed is None or parsed.sub is None or parsed.subsub is not None:
        return parsed

    source, offset = text, 0
    prefix = ANSWER_PREFIX.match(text)
    if prefix:
        offset = prefix.end()
        source = text[offset:]

    numbered = _MCQ_NUMBERED.match(source)
    if numbered:
        end = offset + numbered.end()
        return ParsedLabel(
            display=text[:end].strip(),
            normalized=normalize_parts(numbered.group(1), None, None),
            level=0,
            remainder=text[end:].strip(),
            top=numbered.group(1),
            sub=None,
            subsub=None,
        )
    if parsed.top is None and _MCQ_BARE.match(source):
        return None
    return parsed


def _is_noise_block(block: IRBlock) -> bool:
    """Return True for blocks that are structural noise, not student answer content."""
    text = block.text.strip()
    if not text:
        return True
    if _NOISE_LONE.match(text):
        return True
    if _NOISE_SECTION.match(text):
        return True
    # Short low-confidence fragments (e.g. stray marks, partial words).
    if len(text) < 4 and block.confidence < 0.6:
        return True
    return False


@dataclass
class _Segment:
    page: int
    blocks: list[IRBlock] = field(default_factory=list)
    label_display: str | None = None
    label_normalized: str | None = None


def extract_answers(document: IRDocument) -> AnswerPipelineResult:
    segments: list[_Segment] = []
    for page in sorted(document.pages, key=lambda p: p.page_number):
        segments.extend(_segment_page(page.page_number, sorted(page.blocks, key=lambda b: b.reading_order)))

    answers = [_to_answer(index, segment, document) for index, segment in enumerate(segments)]
    answers = detect_continuations(answers, document)
    low_confidence = [
        answer.answer_id
        for answer in answers
        if answer.confidence < settings.answer_confidence_threshold
    ]
    return AnswerPipelineResult(answers=answers, low_confidence_answer_ids=low_confidence)


# ------------------------------------------------------------------ stage 2: segmentation
def _segment_page(page_number: int, blocks: list[IRBlock]) -> list[_Segment]:
    """Four independent signals: explicit labels, vertical gaps, margin geometry, size."""
    # U1 — drop noise before any segmentation logic sees the blocks.
    blocks = [b for b in blocks if not _is_noise_block(b)]
    if not blocks:
        return []

    gaps = sorted(
        max(0.0, later.bbox.y1 - earlier.bbox.y2)
        for earlier, later in zip(blocks, blocks[1:])
    )
    # The baseline is the page's ordinary line spacing, taken as the lower quartile of
    # gaps rather than the median: on a page with few long answers the median is already
    # an inter-answer gap, and thresholding off it merges every answer into one.
    baseline = gaps[len(gaps) // 4] if gaps else 0.0
    gap_threshold = max(MIN_GAP, baseline * GAP_FACTOR)

    segments: list[_Segment] = []
    current = _Segment(page=page_number)
    for index, block in enumerate(blocks):
        parsed = parse_answer_label(block.text)
        starts_here = False
        if parsed is not None and len(parsed.display) <= 14:
            starts_here = True
        elif index > 0:
            previous = blocks[index - 1]
            vertical_gap = block.bbox.y1 - previous.bbox.y2
            indent_shift = abs(block.bbox.x1 - previous.bbox.x1)
            starts_here = vertical_gap > gap_threshold or (
                vertical_gap > MIN_GAP and indent_shift > INDENT_SHIFT
            )

        if starts_here and current.blocks:
            segments.append(current)
            current = _Segment(page=page_number)
        if starts_here and parsed is not None:
            current.label_display = parsed.display
            current.label_normalized = parsed.normalized
        current.blocks.append(block)

    if current.blocks:
        segments.append(current)
    return segments


def _to_answer(index: int, segment: _Segment, document: IRDocument) -> ExtractedAnswer:
    raw_text = " ".join(block.text for block in segment.blocks).strip()
    page = document.page(segment.page)
    method = page.extraction_method if page else ExtractionMethod.OCR
    confidences = [block.confidence for block in segment.blocks] or [1.0]
    return ExtractedAnswer(
        answer_id=f"a-{segment.page}-{index}",
        raw_text=raw_text,
        normalized_text=normalize_text(raw_text),
        detected_label=segment.label_normalized,
        detected_label_display=segment.label_display,
        page_numbers=[segment.page],
        regions=[Region(page=segment.page, bbox=union_all([b.bbox for b in segment.blocks]))],
        confidence=round(sum(confidences) / len(confidences), 4),
        extraction_method=method,
        block_ids=[block.block_id for block in segment.blocks],
    )


# ---------------------------------------------------------------- stage 3: continuations
def detect_continuations(
    answers: list[ExtractedAnswer], document: IRDocument
) -> list[ExtractedAnswer]:
    """Link a label-less segment at the top of a page to the segment that ran to the
    bottom of the previous page."""
    out = list(answers)
    by_page: dict[int, list[int]] = {}
    for index, answer in enumerate(out):
        by_page.setdefault(answer.page_numbers[0], []).append(index)

    for page in sorted(by_page):
        first_index = by_page[page][0]
        candidate = out[first_index]
        if candidate.detected_label or page - 1 not in by_page:
            continue
        previous_index = by_page[page - 1][-1]
        previous = out[previous_index]
        if previous.regions[-1].bbox.y2 < BOTTOM_OF_PAGE:
            continue
        if candidate.regions[0].bbox.y1 > TOP_OF_PAGE:
            continue
        cue = bool(CONTINUATION_CUES.search(previous.raw_text[-40:]))
        out[first_index] = candidate.model_copy(
            update={
                "is_continuation_of": previous.answer_id,
                "confidence": round(min(1.0, candidate.confidence + (0.05 if cue else 0.0)), 4),
            }
        )
    return out


def merge_continuations(answers: list[ExtractedAnswer]) -> list[ExtractedAnswer]:
    """Fold continuation segments into their parent so a two-page answer competes as a
    single candidate in the mapping solve, not two."""
    by_id = {answer.answer_id: answer for answer in answers}
    children: dict[str, list[ExtractedAnswer]] = {}
    for answer in answers:
        if answer.is_continuation_of and answer.is_continuation_of in by_id:
            children.setdefault(answer.is_continuation_of, []).append(answer)

    merged: list[ExtractedAnswer] = []
    consumed: set[str] = set()
    for answer in answers:
        if answer.answer_id in consumed or answer.is_continuation_of in by_id:
            continue
        chain = [answer]
        cursor = answer.answer_id
        while cursor in children:
            follow = children[cursor][0]
            chain.append(follow)
            consumed.add(follow.answer_id)
            cursor = follow.answer_id
        if len(chain) == 1:
            merged.append(answer)
            continue
        raw = " ".join(item.raw_text for item in chain).strip()
        regions = [region for item in chain for region in item.regions]
        merged.append(
            answer.model_copy(
                update={
                    "raw_text": raw,
                    "normalized_text": normalize_text(raw),
                    "regions": regions,
                    "page_numbers": sorted({region.page for region in regions}),
                    "confidence": round(min(item.confidence for item in chain), 4),
                    "block_ids": [bid for item in chain for bid in item.block_ids],
                }
            )
        )
    return merged


# ----------------------------------------------------------------- stage 5: normalisation
def normalize_text(text: str) -> str:
    """`raw_text` is preserved verbatim; this is what similarity consumes."""
    normalized = unicodedata.normalize("NFKC", text)
    normalized = normalized.replace("’", "'").replace("‘", "'")
    normalized = normalized.replace("“", '"').replace("”", '"')
    normalized = re.sub(r"[‐-―]", "-", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()
