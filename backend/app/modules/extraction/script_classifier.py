"""Printed-vs-handwritten line classification from detector geometry alone.

No layout model. DocLayout-YOLO or PP-StructureV3 would work, and each adds a model
download, a dependency and 0.2-0.5 s per page of CPU inference *before* any OCR runs.
Most of the routing signal is already in the detector's own output, which is the same
instinct as the rest of this codebase: deterministic first, keyword overlap before
embeddings, a model only once the cheap thing is measured and found wanting.

Four signals, computed over the fragments that were grouped into one line:

    recogniser confidence   a print-trained recogniser is systematically less certain
                            on cursive; this is the single strongest signal
    baseline jitter         printed text sits on a straight baseline, so the spread of
                            fragment bottoms is ~0; handwriting drifts
    height variance         print has one x-height per line, handwriting does not
    width-per-character     printed fragments cluster tightly in px-per-char,
                            handwritten ones scatter

Each is mapped to [0,1] where 1.0 is most handwriting-like, then combined by fixed
weights. The score is stored on the block so the confusion rate can be measured off
persisted IR without re-running extraction.

This function produces no coordinates and revises none (ADR-001). A wrong answer costs
recognition quality, never bbox correctness — which is what makes it safe to ship in
telemetry mode first.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.schemas.common import BBox, ScriptClass

# Weights sum to 1.0. Confidence dominates because it is the only signal that reflects
# the recogniser's own difficulty rather than a proxy for it.
W_CONFIDENCE = 0.45
W_BASELINE = 0.25
W_HEIGHT = 0.20
W_WIDTH = 0.10

# Normalisation constants, in normalised page units (bboxes are already [0,1]).
# A baseline spread beyond this is unambiguously hand-drawn.
BASELINE_SATURATION = 0.006
# Coefficient of variation of fragment heights at which the signal saturates.
HEIGHT_CV_SATURATION = 0.35
# Coefficient of variation of per-character width at which the signal saturates.
WIDTH_CV_SATURATION = 0.55
# Confidence at or above which the recogniser is clearly comfortable: printed.
CONFIDENCE_CEILING = 0.95
# Confidence at or below which it is clearly struggling.
CONFIDENCE_FLOOR = 0.45
# Below this score a line is PRINTED; above `threshold` it is HANDWRITTEN; the band
# between is UNCERTAIN and never routed anywhere risky.
UNCERTAIN_BAND = 0.10
# A single-fragment line has no spread to measure, so three of four signals are blind.
MIN_FRAGMENTS_FOR_GEOMETRY = 3


@dataclass(frozen=True)
class ScriptVerdict:
    script: ScriptClass
    score: float
    # Per-signal contributions, kept for the telemetry pass: when the confusion rate is
    # measured, this is what says *which* signal was wrong.
    signals: dict[str, float]


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _coefficient_of_variation(values: list[float]) -> float:
    """Spread normalised by magnitude, so it survives any page size."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    if mean <= 0:
        return 0.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return (variance**0.5) / mean


def _confidence_signal(confidences: list[float]) -> float:
    """Low recogniser confidence -> handwriting-like."""
    if not confidences:
        return 0.0
    worst = min(confidences)
    span = CONFIDENCE_CEILING - CONFIDENCE_FLOOR
    return _clamp((CONFIDENCE_CEILING - worst) / span)


def _baseline_signal(boxes: list[BBox]) -> float:
    """Spread of fragment bottoms. Printed text shares one baseline; script does not."""
    if len(boxes) < MIN_FRAGMENTS_FOR_GEOMETRY:
        return 0.0
    bottoms = [box.y2 for box in boxes]
    mean = sum(bottoms) / len(bottoms)
    spread = (sum((value - mean) ** 2 for value in bottoms) / len(bottoms)) ** 0.5
    return _clamp(spread / BASELINE_SATURATION)


def _height_signal(boxes: list[BBox]) -> float:
    """Print has one x-height per line."""
    if len(boxes) < MIN_FRAGMENTS_FOR_GEOMETRY:
        return 0.0
    heights = [box.y2 - box.y1 for box in boxes if box.y2 > box.y1]
    return _clamp(_coefficient_of_variation(heights) / HEIGHT_CV_SATURATION)


def _width_signal(boxes: list[BBox], texts: list[str]) -> float:
    """Width per character is near-constant for a typeface and scatters for a hand."""
    if len(boxes) < MIN_FRAGMENTS_FOR_GEOMETRY:
        return 0.0
    per_char: list[float] = []
    for box, text in zip(boxes, texts):
        stripped = text.strip()
        if not stripped:
            continue
        width = box.x2 - box.x1
        if width > 0:
            per_char.append(width / len(stripped))
    return _clamp(_coefficient_of_variation(per_char) / WIDTH_CV_SATURATION)


def classify_line(
    boxes: list[BBox],
    texts: list[str],
    confidences: list[float],
    threshold: float,
) -> ScriptVerdict:
    """Score one line's fragments. Pure function: no DB, no network, no model."""
    if not boxes:
        return ScriptVerdict(ScriptClass.UNCERTAIN, 0.0, {})

    signals = {
        "confidence": _confidence_signal(confidences),
        "baseline": _baseline_signal(boxes),
        "height": _height_signal(boxes),
        "width": _width_signal(boxes, texts),
    }
    score = round(
        signals["confidence"] * W_CONFIDENCE
        + signals["baseline"] * W_BASELINE
        + signals["height"] * W_HEIGHT
        + signals["width"] * W_WIDTH,
        4,
    )

    # A one- or two-fragment line only had the confidence signal available, so it can
    # never earn a confident verdict on geometry it does not have.
    if len(boxes) < MIN_FRAGMENTS_FOR_GEOMETRY:
        return ScriptVerdict(ScriptClass.UNCERTAIN, score, signals)

    if score >= threshold:
        script = ScriptClass.HANDWRITTEN
    elif score <= threshold - UNCERTAIN_BAND:
        script = ScriptClass.PRINTED
    else:
        script = ScriptClass.UNCERTAIN
    return ScriptVerdict(script, score, signals)


__all__ = ["ScriptVerdict", "classify_line"]
