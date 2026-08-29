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
    spatial: float = 0.25
    semantic: float = 0.20


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
