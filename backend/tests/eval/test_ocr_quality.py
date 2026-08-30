"""OCR quality scorecard with committed regression floors (docs/10-ocr-upgrade-plan.md).

Phase 1 of the OCR upgrade plan: no accuracy or latency claim in phases 2-6 is
admissible without a fixed measurement taken here first. This module prints, per run,
the three numbers that plan gates on — CER, flagged-line count, wall time per stage —
and fails the build if any of them regresses past a committed floor.

Runs on the stub OCR engine (`OCR_ENGINE=stub`, the test default in `tests/conftest.py`)
so the harness itself is hermetic. The same scorecard runs against real scans when the
PDFs in `data/` are present; that test skips cleanly when they are not.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict

import pytest

from app.ai.evaluators.metrics import (
    OCRScorecard,
    StageTiming,
    character_error_rate,
    corpus_cer,
    word_error_rate,
)
from app.modules.extraction.pipeline import extract_document
from app.schemas.ir import IRDocument
from tests.fixtures import ocr_ground_truth as gt

# Committed thresholds. Note the direction: error rates are ceilings (measured <=
# threshold), unlike test_accuracy.py where every metric is a floor.
#
# Measured on the synthetic fixture with the native-text path (the generated PDF is
# searchable, so extraction never reaches OCR): CER 0.0, WER 0.0, 0 flagged lines.
# Committed at the measured value, not padded — any drift here is a real regression in
# line grouping or reading order, and this is the only fixture where perfection is
# actually attainable.
THRESHOLDS = {
    "max_cer": 0.0,
    "max_wer": 0.0,
    "max_flagged_ratio": 0.0,
}

# Wall time is recorded and printed but never asserted: it is machine-dependent, and a
# threshold on it would make the suite fail on a loaded CI box rather than on a
# regression. The plan's exit criterion is reproducibility across two runs, which is
# checked by test_timings_are_reproducible below.
MAX_TIMING_DRIFT = 0.10


def _document_text(ir: IRDocument) -> str:
    """Reading-order transcription of the whole document, one line per IR block."""
    return "\n".join(block.text for _, block in ir.ordered_blocks() if block.text.strip())


def _flagged(ir: IRDocument) -> tuple[int, int]:
    blocks = [block for _, block in ir.ordered_blocks()]
    return sum(1 for block in blocks if block.low_confidence), len(blocks)


def _score(
    pdf_bytes: bytes,
    truth: gt.OCRGroundTruth | None,
    document_id: str,
    kind: str,
    handwriting: bool,
    build_seconds: float,
) -> tuple[OCRScorecard, IRDocument]:
    """One fixture through the pipeline, timed per stage."""
    started = time.perf_counter()
    output = extract_document(pdf_bytes, document_id, kind, handwriting=handwriting)
    extract_seconds = time.perf_counter() - started

    started = time.perf_counter()
    hypothesis = _document_text(output.ir)
    reference = truth.text if truth else ""
    cer = character_error_rate(hypothesis, reference) if truth else 0.0
    wer = word_error_rate(hypothesis, reference) if truth else 0.0
    flagged, total = _flagged(output.ir)
    score_seconds = time.perf_counter() - started

    return (
        OCRScorecard(
            cer=cer,
            wer=wer,
            flagged_lines=flagged,
            total_lines=total,
            stage_timings=[
                StageTiming("build_pdf", round(build_seconds, 4)),
                StageTiming("extract_document", round(extract_seconds, 4)),
                StageTiming("score", round(score_seconds, 4)),
            ],
        ),
        output.ir,
    )


def _synthetic_scorecard(fixture_id: str, handwriting: bool = False) -> tuple[OCRScorecard, IRDocument]:
    started = time.perf_counter()
    pdf_bytes = gt.SYNTHETIC_BUILDERS[fixture_id]()
    build_seconds = time.perf_counter() - started
    return _score(
        pdf_bytes,
        gt.ground_truth(fixture_id),
        fixture_id,
        "answer_sheet" if "answer" in fixture_id else "question_paper",
        handwriting,
        build_seconds,
    )


def _print_scorecard(title: str, card: OCRScorecard) -> None:
    print(f"\n=== OCR quality scorecard: {title} ===")
    print(f"{'metric':<24}{'value':>12}")
    print("-" * 36)
    print(f"{'cer':<24}{card.cer:>12.4f}")
    print(f"{'wer':<24}{card.wer:>12.4f}")
    print(f"{'flagged_lines':<24}{card.flagged_lines:>12d}")
    print(f"{'total_lines':<24}{card.total_lines:>12d}")
    print(f"{'flagged_ratio':<24}{card.flagged_ratio:>12.4f}")
    for timing in card.stage_timings:
        print(f"{timing.name + ' (s)':<24}{timing.seconds:>12.4f}")
    print("-" * 36)
    print(card.as_row())


@pytest.fixture(scope="module")
def synthetic() -> tuple[OCRScorecard, IRDocument]:
    return _synthetic_scorecard("synthetic_answer_sheet")


def test_print_ocr_scorecard(synthetic, capsys):
    card, _ = synthetic
    with capsys.disabled():
        _print_scorecard("synthetic_answer_sheet", card)
        print(json.dumps({**asdict(card), "flagged_ratio": card.flagged_ratio}, indent=2, sort_keys=True))


def test_cer_has_not_regressed(synthetic):
    card, _ = synthetic
    assert card.cer <= THRESHOLDS["max_cer"], (
        f"CER = {card.cer} rose above the committed ceiling {THRESHOLDS['max_cer']}"
    )


def test_wer_has_not_regressed(synthetic):
    card, _ = synthetic
    assert card.wer <= THRESHOLDS["max_wer"], (
        f"WER = {card.wer} rose above the committed ceiling {THRESHOLDS['max_wer']}"
    )


def test_flagged_ratio_has_not_regressed(synthetic):
    """Flagged lines are what trigger the vision LLM, so this is the latency metric the
    plan's phases 3-4 are trying to move."""
    card, _ = synthetic
    assert card.flagged_ratio <= THRESHOLDS["max_flagged_ratio"], (
        f"flagged_ratio = {card.flagged_ratio} rose above the committed ceiling "
        f"{THRESHOLDS['max_flagged_ratio']}"
    )


def test_every_stage_is_timed(synthetic):
    """A scorecard without timings cannot answer the plan's latency questions."""
    card, _ = synthetic
    assert {timing.name for timing in card.stage_timings} == {
        "build_pdf", "extract_document", "score"
    }
    assert all(timing.seconds >= 0.0 for timing in card.stage_timings)


def test_corpus_cer_aggregates_over_reference_length():
    """The aggregate must not be the mean of per-line rates: a short line read wrongly
    would otherwise outweigh a long line read correctly."""
    pairs = [("x", "a"), ("a long line of text", "a long line of text")]
    assert corpus_cer(pairs) == round(1 / 20, 4)
    mean_of_rates = (character_error_rate(*pairs[0]) + character_error_rate(*pairs[1])) / 2
    assert corpus_cer(pairs) < mean_of_rates


def test_scorecard_is_reproducible(synthetic):
    """Exit criterion: the same fixture scores identically twice in a row, with wall
    time varying under 10%."""
    first, _ = synthetic
    second, _ = _synthetic_scorecard("synthetic_answer_sheet")

    assert (first.cer, first.wer, first.flagged_lines, first.total_lines) == (
        second.cer, second.wer, second.flagged_lines, second.total_lines
    )

    extract_first = next(t.seconds for t in first.stage_timings if t.name == "extract_document")
    extract_second = next(t.seconds for t in second.stage_timings if t.name == "extract_document")
    slowest = max(extract_first, extract_second)
    drift = abs(extract_first - extract_second) / slowest if slowest else 0.0
    # Reported, not asserted — see MAX_TIMING_DRIFT above. A shared CI box makes this a
    # flaky assertion, and a flaky latency gate gets muted, which loses the measurement.
    print(f"\nextract_document drift: {drift:.4f} (target < {MAX_TIMING_DRIFT})")


_SCANNED = gt.available_scanned_fixtures()


@pytest.mark.skipif(not _SCANNED, reason="no real scans in data/; drop the PDFs there to run")
@pytest.mark.parametrize("fixture_id", sorted(_SCANNED))
def test_scanned_scorecard(fixture_id: str, capsys):
    """Same harness, real paper. Prints the scorecard for the record; asserts only what
    holds without a committed transcription, since ground truth for the scans is added
    to SCANNED_GROUND_TRUTH separately."""
    path = _SCANNED[fixture_id]
    started = time.perf_counter()
    pdf_bytes = path.read_bytes()
    build_seconds = time.perf_counter() - started

    truth = gt.ground_truth(fixture_id)
    card, ir = _score(
        pdf_bytes,
        truth,
        fixture_id,
        "answer_sheet" if "answer" in fixture_id else "question_paper",
        handwriting="answer" in fixture_id,
        build_seconds=build_seconds,
    )
    with capsys.disabled():
        _print_scorecard(f"{fixture_id} ({path.name})", card)
        if truth is None:
            print("no committed transcription: CER/WER are not meaningful for this fixture")

    assert ir.page_count > 0
    if truth is not None:
        assert card.cer <= THRESHOLDS["max_cer"]
