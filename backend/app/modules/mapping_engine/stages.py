"""Mapping stages 1, 2 and 4 as independent, individually testable scorers.

Each stage can be disabled from the engine so its contribution is measurable.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.modules.mapping_engine.similarity import semantic_score
from app.modules.question_pipeline.labels import sort_key
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion

LABEL_EXACT = 1.0
LABEL_PARENT = 0.55


@dataclass(frozen=True)
class StageWeights:
    label: float = 0.55
    spatial: float = 0.20  # U4 — reduced from 0.25 to give semantic more influence
    semantic: float = 0.25  # U4 — raised from 0.20; vision-corrected text is cleaner


DEFAULT_WEIGHTS = StageWeights()


# --------------------------------------------------------------- stage 1: explicit label
def label_score(question: ExtractedQuestion, answer: ExtractedAnswer) -> float:
    """Where a student wrote `11(a)`, that is near-certain evidence and costs nothing."""
    if not answer.detected_label:
        return 0.0
    if answer.detected_label == question.normalized_number:
        return LABEL_EXACT
    # A student writing only "11" against question "11(a)" is weak but real evidence.
    if question.normalized_number.startswith(f"{answer.detected_label}."):
        return LABEL_PARENT
    if answer.detected_label.startswith(f"{question.normalized_number}."):
        return LABEL_PARENT
    return 0.0


# U2 — Question-number offset resolver.
# Detects the integer offset between answer-sheet numbering and question-paper numbering
# from the first confident direct match, then applies it to all remaining label comparisons.
def _extract_top_int(label: str) -> int | None:
    """Return the leading integer from a normalised label, e.g. '18.a' -> 18."""
    part = label.split(".")[0]
    return int(part) if part.isdigit() else None


def detect_label_offset(
    questions: list[ExtractedQuestion],
    answers: list[ExtractedAnswer],
) -> int:
    """Scan all (question, answer) pairs for exact label matches and derive the
    most common integer offset between answer-sheet numbers and question numbers.
    Returns 0 when no offset is detectable (i.e. numbering already matches).
    """
    offsets: dict[int, int] = {}
    for answer in answers:
        if not answer.detected_label:
            continue
        a_top = _extract_top_int(answer.detected_label)
        if a_top is None:
            continue
        for question in questions:
            q_top = _extract_top_int(question.normalized_number)
            if q_top is None:
                continue
            if answer.detected_label == question.normalized_number:
                # Already matches — offset is 0 for this pair.
                offsets[0] = offsets.get(0, 0) + 1
            elif a_top - q_top != 0:
                # Candidate offset: answer number minus question number.
                diff = a_top - q_top
                offsets[diff] = offsets.get(diff, 0) + 1
    if not offsets:
        return 0
    # Return the most frequently observed offset.
    return max(offsets, key=lambda k: offsets[k])


def label_score_with_offset(
    question: ExtractedQuestion, answer: ExtractedAnswer, offset: int
) -> float:
    """label_score that also tries the offset-adjusted label before giving up."""
    base = label_score(question, answer)
    if base > 0.0 or offset == 0 or not answer.detected_label:
        return base
    a_top = _extract_top_int(answer.detected_label)
    q_top = _extract_top_int(question.normalized_number)
    if a_top is None or q_top is None:
        return 0.0
    if a_top - q_top != offset:
        return 0.0
    # Sub-part must also match when present.
    a_parts = answer.detected_label.split(".")
    q_parts = question.normalized_number.split(".")
    if a_parts[1:] == q_parts[1:]:
        return LABEL_EXACT
    if not a_parts[1:] and q_parts[1:]:
        return LABEL_PARENT
    return 0.0


# --------------------------------------------------------- stage 2: spatial / page prior
def spatial_score(
    question: ExtractedQuestion,
    answer: ExtractedAnswer,
    question_rank: dict[str, float],
    answer_rank: dict[str, float],
) -> float:
    """Most sheets are near-ordered, so preserving monotonic order is informative and free.

    This is what rescues unlabelled answers: position beats semantics on short handwriting.
    """
    q = question_rank.get(question.question_id)
    a = answer_rank.get(answer.answer_id)
    if q is None or a is None:
        return 0.0
    return round(max(0.0, 1.0 - abs(q - a)), 4)


def build_ranks(items: list[str]) -> dict[str, float]:
    """Map an ordered list of ids onto evenly spaced positions in [0, 1]."""
    if not items:
        return {}
    if len(items) == 1:
        return {items[0]: 0.5}
    return {item: index / (len(items) - 1) for index, item in enumerate(items)}


def question_order(questions: list[ExtractedQuestion]) -> list[str]:
    return [q.question_id for q in sorted(questions, key=lambda q: sort_key(q.normalized_number))]


def answer_order(answers: list[ExtractedAnswer]) -> list[str]:
    def key(answer: ExtractedAnswer) -> tuple[int, float]:
        region = answer.regions[0] if answer.regions else None
        return (answer.page_numbers[0] if answer.page_numbers else 0, region.bbox.y1 if region else 0.0)

    return [a.answer_id for a in sorted(answers, key=key)]


# ------------------------------------------------------------- stage 4: semantic overlap
def semantic_stage_score(question: ExtractedQuestion, answer: ExtractedAnswer) -> float:
    return semantic_score(question.text, answer.normalized_text)


def combine(
    label: float, spatial: float, semantic: float, weights: StageWeights = DEFAULT_WEIGHTS
) -> float:
    """An exact label is decisive on its own; otherwise the weighted blend decides."""
    if label >= LABEL_EXACT:
        return 0.97
    combined = weights.label * label + weights.spatial * spatial + weights.semantic * semantic
    # Without a label the two remaining signals must carry the full range on their own.
    if label == 0.0:
        denominator = weights.spatial + weights.semantic
        combined = (weights.spatial * spatial + weights.semantic * semantic) / denominator
        combined *= 0.85  # unlabelled matches are never as certain as labelled ones
    return round(min(0.99, max(0.0, combined)), 4)
