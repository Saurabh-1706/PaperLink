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
    roman_to_int,
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


# A bare label's family + ordinal within it, e.g. ("top", 5) for "5.", ("sub", 0) for
# "a)", ("subsub", 1) for "ii)" -- see `_bare_ordinal`.
_Ordinal = tuple[str, int]


@dataclass
class _LastRealTop:
    """Threaded across the whole sheet -- see `_classify_labels`.

    `value`: family + ordinal of the most recently confirmed REAL label.
    `last_point`: family + ordinal of the most recently confirmed POINT (part of a
    suppressed run). Without this, a point list that wraps onto a new page starting
    mid-sequence ("c)" continuing "a), b)" from the page before) has no value == 0 to
    signal a fresh list start, and would wrongly be read as a real label again. Reset
    to None whenever a new real top-level label is confirmed -- a point list is scoped
    to the answer it lives inside, not carried into a later, unrelated question.
    """

    value: _Ordinal | None = None
    last_point: _Ordinal | None = None


def extract_answers(document: IRDocument) -> AnswerPipelineResult:
    segments: list[_Segment] = []
    # Threaded across every page: a numbered point inside a long answer ("1. ... 2. ...
    # 3. ...") parses exactly like a question label, and without this context each point
    # would start its own segment -- shattering one long answer into fragments that
    # compete against unrelated questions in the mapping engine, and (when a point lands
    # first on a page) blocking the cross-page continuation link below, which requires
    # the continuing segment to carry no label at all. See `_plausible_new_answer_label`.
    last_real_top = _LastRealTop()
    for page in sorted(document.pages, key=lambda p: p.page_number):
        segments.extend(
            _segment_page(
                page.page_number, sorted(page.blocks, key=lambda b: b.reading_order), last_real_top
            )
        )

    answers = [_to_answer(index, segment, document) for index, segment in enumerate(segments)]
    answers = detect_continuations(answers, document)
    low_confidence = [
        answer.answer_id
        for answer in answers
        if answer.confidence < settings.answer_confidence_threshold
    ]
    return AnswerPipelineResult(answers=answers, low_confidence_answer_ids=low_confidence)


# ------------------------------------------------------------------ stage 2: segmentation
def _bare_ordinal(parsed: ParsedLabel) -> _Ordinal | None:
    """The family + ordinal of a BARE (single-component) label -- "5." is ("top", 5),
    "a)" is ("sub", 0), "ii)" is ("subsub", 2). A compound label like "5.a" or "11(a)(ii)"
    identifies a specific hierarchical position on its own and is never mistaken for a
    point list, so it deliberately returns None here rather than picking one component.
    """
    if parsed.top and not parsed.sub and not parsed.subsub:
        return ("top", int(parsed.top))
    if parsed.sub and not parsed.top and not parsed.subsub:
        return ("sub", ord(parsed.sub.lower()) - ord("a"))
    if parsed.subsub and not parsed.top and not parsed.sub:
        return ("subsub", roman_to_int(parsed.subsub) - 1)  # i -> 0, matching "sub"'s a -> 0
    return None


def _classify_labels(
    parsed_labels: list[ParsedLabel | None],
    blocks: list[IRBlock],
    last_real_top: _LastRealTop,
    gap_threshold: float,
) -> list[bool]:
    """Tell a genuine question-label boundary apart from a point inside the answer
    above it -- numbered ("1. ... 2. ... 3. ..."), lettered ("a) ... b) ... c) ..."),
    or roman ("i) ... ii) ... iii) ...").

    All three parse exactly like a real label -- `parse_answer_label` cannot see the
    difference on its own, and each family needs a different suspicion signal:

    - Numbers ("top") have a sheet-wide expected direction -- question numbers climb
      through the paper -- so a backward step (e.g. "3." then "1.") is the tell. But a
      single backward step is also exactly what a legitimate out-of-order answer looks
      like (a student circling back to an earlier question), so demoting every one
      would strip real answers of the label the mapping engine needs most.
    - Letters and romans ("sub"/"subsub") have no such expectation: "a), b), c)" looks
      identical whether it is a fresh point list or three genuine sub-part answers.
      What stands in for "expected direction" there is starting at the natural
      beginning of the sequence (a/i), OR continuing exactly where the last confirmed
      point run left off (so a list that wraps onto a new page starting mid-sequence,
      e.g. "c)" continuing "a), b)" from the page before, is still recognised) --
      either way with no room to breathe (a tight gap), since genuine sub-part answers
      tend to get their own paragraph.

    Either way, what confirms a point list is repetition: it is a RUN of 2+ consecutive
    candidate labels in the SAME family climbing ordinal, ordinal+1, ordinal+2, ..., not
    a single suspicious-looking one; every step into the run must itself be tightly
    spaced, or it opens its own paragraph and is a real, separate answer. A compound
    label (`_bare_ordinal` returns None) is always real and never updates `last_real` --
    a bare label after it is judged against whichever bare label came before, not a
    compound one it cannot be meaningfully compared to.

    Mutates `last_real_top` in place as it goes, so the caller can thread the running
    state on to the next page.
    """
    n = len(parsed_labels)
    is_real = [False] * n
    index = 0
    while index < n:
        parsed = parsed_labels[index]
        if parsed is None:
            index += 1
            continue
        ordinal = _bare_ordinal(parsed)
        vertical_gap = blocks[index].bbox.y1 - blocks[index - 1].bbox.y2 if index > 0 else 0.0
        last_real, last_point = last_real_top.value, last_real_top.last_point

        is_suspect = False
        if ordinal is not None and last_real is not None:
            family, value = ordinal
            if family == "top":
                is_suspect = family == last_real[0] and value < last_real[1]
            else:
                continues_run = last_point is not None and last_point == (family, value - 1)
                is_suspect = value == 0 or continues_run
            is_suspect = is_suspect and vertical_gap <= gap_threshold

        if not is_suspect:
            is_real[index] = True
            if ordinal is not None:
                last_real_top.value = ordinal
                if ordinal[0] == "top":
                    last_real_top.last_point = None  # a fresh question ends any point run
            index += 1
            continue

        # Suspicious start -- only demote it if a run of consecutive labels actually
        # follows, climbing value, value+1, value+2, ... (`family`/`value` are already
        # bound above: `is_suspect` can only be True when `ordinal` was not None).
        # Every step into the run must itself be tightly spaced: a big gap before,
        # say, "b)" means it opens its own paragraph -- a real, separate answer -- even
        # if "a)" right before it looked like the start of a list.
        run = [index]
        expected = value + 1
        cursor = index + 1
        while cursor < n:
            candidate = parsed_labels[cursor]
            if candidate is None:
                cursor += 1
                continue
            candidate_gap = blocks[cursor].bbox.y1 - blocks[cursor - 1].bbox.y2
            if _bare_ordinal(candidate) != (family, expected) or candidate_gap > gap_threshold:
                break
            run.append(cursor)
            expected += 1
            cursor += 1

        if len(run) >= 2:
            last_real_top.last_point = (family, expected - 1)  # last run member's ordinal
            index = cursor  # a genuine point run: none of these become real labels
            continue
        is_real[index] = True  # isolated backward step: a real (out-of-order) answer
        last_real_top.value = ordinal
        if family == "top":
            last_real_top.last_point = None
        index += 1
    return is_real


def _segment_page(
    page_number: int, blocks: list[IRBlock], last_real_top: _LastRealTop
) -> list[_Segment]:
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

    raw_parsed = [parse_answer_label(block.text) for block in blocks]
    # Only a label short enough to plausibly BE a label (not a long line that merely
    # starts with something label-shaped) is eligible to trigger a new segment on its
    # own; classify those into "real" vs "just a point in the answer above".
    eligible = [p if p is not None and len(p.display) <= 14 else None for p in raw_parsed]
    is_real_label = _classify_labels(eligible, blocks, last_real_top, gap_threshold)

    segments: list[_Segment] = []
    current = _Segment(page=page_number)
    for index, block in enumerate(blocks):
        parsed = raw_parsed[index]
        eligible_parsed = eligible[index]
        vertical_gap = block.bbox.y1 - blocks[index - 1].bbox.y2 if index > 0 else 0.0

        starts_here = False
        if eligible_parsed is not None and is_real_label[index]:
            starts_here = True
        elif eligible_parsed is None and index > 0:
            indent_shift = abs(block.bbox.x1 - blocks[index - 1].bbox.x1)
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
    """Link a label-less segment to the segment immediately before it — across a page
    break, or across an oversized gap on the same page — when nothing suggests it is
    really a separate answer.

    A same-page split happens when a student leaves an unusually large gap mid-answer
    (skips a line, works around a diagram, pauses): `_segment_page`'s gap threshold then
    reads that as the start of a new answer, and without reconciliation the answer's
    second half becomes its own unrelated candidate — incomplete text on the question it
    really belongs to, and a stray fragment that can map to the wrong question or none.

    Cross-page linking has a strong geometric tell (ran to the bottom of one page,
    resumes at the top of the next) and stays confidence-gated only by that. Same-page
    linking has no comparably strong signal — margin alignment alone is not enough: most
    handwritten answers share the same left margin regardless of whether they are the
    same answer or the next one entirely (this is exactly what a plain vertical-gap
    split looks like). So same-page linking additionally *requires* the student's own
    explicit continuation cue ("contd.", "P.T.O.", …) at the end of the previous
    segment — the one unambiguous signal available without inventing a merge heuristic
    that would just as easily fuse two genuinely different answers together.
    """
    out = list(answers)
    by_page: dict[int, list[int]] = {}
    for index, answer in enumerate(out):
        by_page.setdefault(answer.page_numbers[0], []).append(index)

    for page in sorted(by_page):
        indices = by_page[page]

        # Same-page: a label-less segment may continue the one right before it.
        for position in range(1, len(indices)):
            this_index = indices[position]
            candidate = out[this_index]
            if candidate.detected_label:
                continue
            previous = out[indices[position - 1]]
            indent_shift = abs(candidate.regions[0].bbox.x1 - previous.regions[-1].bbox.x1)
            if indent_shift > INDENT_SHIFT:
                continue
            if not CONTINUATION_CUES.search(previous.raw_text[-40:]):
                continue
            out[this_index] = candidate.model_copy(
                update={
                    "is_continuation_of": previous.answer_id,
                    "confidence": round(min(1.0, candidate.confidence + 0.05), 4),
                }
            )

        # Cross-page: the first segment of a page may continue the last of the previous.
        first_index = indices[0]
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
