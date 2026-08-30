"""Phase 4: deterministic printed-vs-handwritten line classification.

The classifier ships in telemetry mode, so these tests are the evidence that routing on
it would be safe — not a substitute for measuring the confusion rate on real papers.
"""
from __future__ import annotations

from app.modules.extraction.script_classifier import classify_line
from app.schemas.common import BBox, ScriptClass

THRESHOLD = 0.55


def _printed_line(fragments: int = 6) -> tuple[list[BBox], list[str], list[float]]:
    """A typeset line: one baseline, one x-height, uniform width per character."""
    boxes, texts, confidences = [], [], []
    x = 0.10
    for _ in range(fragments):
        word = "word"
        width = 0.008 * len(word)
        boxes.append(BBox(x1=x, y1=0.300, x2=x + width, y2=0.318))
        texts.append(word)
        confidences.append(0.97)
        x += width + 0.010
    return boxes, texts, confidences


def _handwritten_line(fragments: int = 6) -> tuple[list[BBox], list[str], list[float]]:
    """A hand-written line: drifting baseline, varying heights, irregular widths, and
    the low recogniser confidence a print-trained model produces on cursive."""
    drift = [0.000, 0.004, -0.003, 0.006, -0.005, 0.003]
    heights = [0.018, 0.026, 0.015, 0.030, 0.020, 0.028]
    widths = [0.030, 0.070, 0.025, 0.090, 0.040, 0.060]
    words = ["the", "mitochondria", "is", "powerhouse", "of", "cell"]
    boxes, texts, confidences = [], [], []
    x = 0.10
    for index in range(fragments):
        top = 0.300 + drift[index]
        boxes.append(BBox(x1=x, y1=top, x2=x + widths[index], y2=top + heights[index]))
        texts.append(words[index])
        confidences.append(0.52)
        x += widths[index] + 0.012
    return boxes, texts, confidences


def test_printed_line_is_classified_printed():
    verdict = classify_line(*_printed_line(), THRESHOLD)
    assert verdict.script is ScriptClass.PRINTED
    assert verdict.score < THRESHOLD


def test_handwritten_line_is_classified_handwritten():
    verdict = classify_line(*_handwritten_line(), THRESHOLD)
    assert verdict.script is ScriptClass.HANDWRITTEN
    assert verdict.score >= THRESHOLD


def test_handwriting_scores_strictly_higher_than_print():
    """The ordering is what matters; the absolute threshold is tunable config."""
    printed = classify_line(*_printed_line(), THRESHOLD)
    written = classify_line(*_handwritten_line(), THRESHOLD)
    assert written.score > printed.score


def test_short_line_is_uncertain_not_guessed():
    """Two fragments carry no baseline, height or width spread — three of four signals
    are blind, so the classifier must decline rather than route on confidence alone."""
    boxes, texts, confidences = _handwritten_line(fragments=2)
    verdict = classify_line(boxes, texts, confidences, THRESHOLD)
    assert verdict.script is ScriptClass.UNCERTAIN


def test_empty_line_is_uncertain():
    verdict = classify_line([], [], [], THRESHOLD)
    assert verdict.script is ScriptClass.UNCERTAIN
    assert verdict.score == 0.0


def test_signals_are_reported_for_telemetry():
    """The telemetry pass has to say *which* signal was wrong, not just that it was."""
    verdict = classify_line(*_handwritten_line(), THRESHOLD)
    assert set(verdict.signals) == {"confidence", "baseline", "height", "width"}
    assert all(0.0 <= value <= 1.0 for value in verdict.signals.values())


def test_low_confidence_alone_does_not_force_handwritten():
    """A printed line the recogniser happened to find hard keeps its clean geometry, so
    it must not be routed to a handwriting model on the confidence signal alone."""
    boxes, texts, _ = _printed_line()
    verdict = classify_line(boxes, texts, [0.50] * len(boxes), THRESHOLD)
    assert verdict.script is not ScriptClass.HANDWRITTEN


def test_score_is_bounded():
    for factory in (_printed_line, _handwritten_line):
        verdict = classify_line(*factory(), THRESHOLD)
        assert 0.0 <= verdict.score <= 1.0
