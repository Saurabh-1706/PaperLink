"""Accuracy metrics (docs/06-evaluation.md).

Mapping accuracy is reported per `mapping_type`: an aggregate number hides the thing
that matters, because `direct` matches on labelled sheets always score well.
"""
from __future__ import annotations

from collections.abc import Sequence
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


# --- Transcription quality (docs/10-ocr-upgrade-plan.md, Phase 1) -------------------
#
# Every OCR phase in that plan claims an accuracy delta. A delta is only meaningful
# against a metric that cannot itself drift, so these are defined here once and
# committed, rather than recomputed ad hoc in each probe script.


def levenshtein(a: str, b: str) -> int:
    """Edit distance, iterative two-row DP.

    `rapidfuzz` is already a dependency and would be faster, but its distance functions
    apply their own processor/normalisation defaults which have changed across releases.
    A CER threshold committed to the repository must not move because a transitive
    dependency was upgraded, so the metric owns its own arithmetic.
    """
    return _edit_distance(a, b)


def _edit_distance(a: Sequence, b: Sequence) -> int:
    """Same DP over any sequence, so WER can reuse it on token lists."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, start=1):
        current = [i]
        for j, char_b in enumerate(b, start=1):
            current.append(
                min(
                    previous[j] + 1,                              # deletion
                    current[j - 1] + 1,                           # insertion
                    previous[j - 1] + (char_a != char_b),         # substitution
                )
            )
        previous = current
    return previous[-1]


def _error_rate(hypothesis_units: Sequence, reference_units: Sequence) -> float:
    if not reference_units:
        # An empty reference cannot be scored: nothing was expected, so anything
        # produced is entirely spurious and anything absent is entirely right.
        return 0.0 if not hypothesis_units else 1.0
    distance = _edit_distance(hypothesis_units, reference_units)
    return round(max(0.0, min(1.0, distance / len(reference_units))), 4)


def character_error_rate(hypothesis: str, reference: str) -> float:
    """CER for one transcription. Clamped to [0,1].

    Uncapped CER is unbounded above (a hallucinating recogniser can emit ten times the
    reference), which makes a corpus average meaningless and a regression threshold
    unreadable. Clamping keeps every reported number comparable.
    """
    return _error_rate(list(hypothesis), list(reference))


def corpus_cer(pairs: list[tuple[str, str]]) -> float:
    """Aggregate CER over `(hypothesis, reference)` pairs.

    Total edit distance divided by total reference length — deliberately NOT the mean of
    the per-line CERs. The mean weights every line equally, so a three-character label
    that OCR misses entirely (CER 1.0) counts as much as a eighty-character sentence
    read perfectly, and a page of short headers can swamp the body text the metric is
    supposed to be measuring.
    """
    total_distance = 0
    total_reference = 0
    for hypothesis, reference in pairs:
        total_distance += levenshtein(hypothesis, reference)
        total_reference += len(reference)
    if not total_reference:
        return 0.0 if not any(hypothesis for hypothesis, _ in pairs) else 1.0
    return round(max(0.0, min(1.0, total_distance / total_reference)), 4)


def word_error_rate(hypothesis: str, reference: str) -> float:
    """WER on whitespace tokens.

    Reported alongside CER because the two fail differently: a systematic character
    confusion (l/1, rn/m) shows up small in CER and large in WER, and word-level damage
    is what actually breaks question-number parsing downstream.
    """
    return _error_rate(hypothesis.split(), reference.split())


@dataclass
class StageTiming:
    name: str
    seconds: float


@dataclass
class OCRScorecard:
    """The three numbers Phase 1 gates every later phase on, in one object."""

    cer: float
    wer: float
    flagged_lines: int
    total_lines: int
    stage_timings: list[StageTiming] = field(default_factory=list)

    @property
    def flagged_ratio(self) -> float:
        """Flagged lines drive vision-LLM fan-out, so this is a latency metric as much
        as a quality one."""
        if not self.total_lines:
            return 0.0
        return round(self.flagged_lines / self.total_lines, 4)

    def as_row(self) -> str:
        timings = " ".join(f"{t.name}={t.seconds:.3f}s" for t in self.stage_timings)
        return (
            f"CER={self.cer:.4f} WER={self.wer:.4f} "
            f"flagged={self.flagged_lines}/{self.total_lines} "
            f"({self.flagged_ratio:.4f}) {timings}".rstrip()
        )
