"""Accuracy metrics (docs/06-evaluation.md).

Mapping accuracy is reported per `mapping_type`: an aggregate number hides the thing
that matters, because `direct` matches on labelled sheets always score well.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.common import BBox, MappingType
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion, Mapping

IOU_GOOD = 0.7


@dataclass
class PRF:
    precision: float
    recall: float
    f1: float


def prf(true_positives: int, predicted: int, actual: int) -> PRF:
    precision = true_positives / predicted if predicted else 0.0
    recall = true_positives / actual if actual else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return PRF(round(precision, 4), round(recall, 4), round(f1, 4))


def question_number_accuracy(
    questions: list[ExtractedQuestion], expected_numbers: list[str]
) -> float:
    predicted = [question.normalized_number for question in questions]
    hits = sum(1 for number in expected_numbers if number in predicted)
    return round(hits / len(expected_numbers), 4) if expected_numbers else 0.0


def question_extraction_prf(
    questions: list[ExtractedQuestion], expected_numbers: list[str]
) -> PRF:
    predicted = {question.normalized_number for question in questions}
    expected = set(expected_numbers)
    return prf(len(predicted & expected), len(predicted), len(expected))


def answer_extraction_prf(answers: list[ExtractedAnswer], expected_count: int) -> PRF:
    non_empty = [answer for answer in answers if answer.normalized_text.strip()]
    matched = min(len(non_empty), expected_count)
    return prf(matched, len(non_empty), expected_count)


@dataclass
class MappingAccuracy:
    overall: float = 0.0
    by_type: dict[str, float] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)


def mapping_accuracy(
    mappings: list[Mapping],
    questions: dict[str, ExtractedQuestion],
    answers: dict[str, ExtractedAnswer],
    expected_pairs: dict[str, str],
) -> MappingAccuracy:
    """`expected_pairs` maps a question's normalized_number to the answer label that
    should be attached to it."""
    correct_by_type: dict[str, int] = {}
    total_by_type: dict[str, int] = {}
    correct = 0
    considered = 0

    for mapping in mappings:
        if mapping.question_id is None:
            continue
        question = questions.get(mapping.question_id)
        if question is None or question.normalized_number not in expected_pairs:
            continue
        considered += 1
        kind = str(mapping.mapping_type)
        total_by_type[kind] = total_by_type.get(kind, 0) + 1
        answer = answers.get(mapping.answer_id or "")
        expected_label = expected_pairs[question.normalized_number]
        if answer is not None and _answer_matches(answer, expected_label):
            correct += 1
            correct_by_type[kind] = correct_by_type.get(kind, 0) + 1

    return MappingAccuracy(
        overall=round(correct / considered, 4) if considered else 0.0,
        by_type={
            kind: round(correct_by_type.get(kind, 0) / total, 4)
            for kind, total in total_by_type.items()
        },
        counts=total_by_type,
    )


def _answer_matches(answer: ExtractedAnswer, expected_label: str) -> bool:
    if answer.detected_label:
        return answer.detected_label == expected_label
    return answer.normalized_text.strip().startswith(expected_label)


def unanswered_prf(
    mappings: list[Mapping], questions: dict[str, ExtractedQuestion], expected_unanswered: list[str]
) -> PRF:
    predicted = {
        questions[mapping.question_id].normalized_number
        for mapping in mappings
        if mapping.question_id in questions and mapping.mapping_type == MappingType.UNANSWERED
    }
    expected = set(expected_unanswered)
    return prf(len(predicted & expected), len(predicted), len(expected))


def multipage_answer_accuracy(
    answers: list[ExtractedAnswer], expected_multipage_labels: list[str]
) -> float:
    """Percentage of multi-page answers whose regions were ALL recovered."""
    if not expected_multipage_labels:
        return 1.0
    recovered = 0
    for label in expected_multipage_labels:
        match = next(
            (answer for answer in answers if _answer_matches(answer, label)), None
        )
        if match and len({region.page for region in match.regions}) > 1:
            recovered += 1
    return round(recovered / len(expected_multipage_labels), 4)


def bbox_accuracy(predicted: list[BBox], truth: list[BBox]) -> dict[str, float]:
    if not truth:
        return {"mean_iou": 0.0, "above_threshold": 0.0}
    ious = []
    for expected in truth:
        best = max((expected.iou(box) for box in predicted), default=0.0)
        ious.append(best)
    return {
        "mean_iou": round(sum(ious) / len(ious), 4),
        "above_threshold": round(sum(1 for iou in ious if iou >= IOU_GOOD) / len(ious), 4),
    }
