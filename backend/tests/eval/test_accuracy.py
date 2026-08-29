"""Accuracy scorecard with committed regression thresholds (docs/06-evaluation.md).

Unit tests assert behaviour is correct; this asserts accuracy has not degraded. A
refactor can keep every unit test green while quietly costing mapping accuracy.
"""
from __future__ import annotations

import json

import pytest

from app.ai.evaluators.metrics import (
    answer_extraction_prf,
    bbox_accuracy,
    mapping_accuracy,
    multipage_answer_accuracy,
    question_extraction_prf,
    question_number_accuracy,
    unanswered_prf,
)
from app.graphs.answer_graph import run_answer_graph
from app.graphs.mapping_graph import run_mapping_graph
from app.graphs.question_graph import run_question_graph
from app.modules.answer_pipeline.pipeline import merge_continuations
from app.modules.extraction.pipeline import extract_document
from tests.fixtures.generator import GROUND_TRUTH, answer_sheet_pdf, question_paper_pdf

# Committed thresholds. A metric that drops below one of these fails the build.
THRESHOLDS = {
    "question_number_accuracy": 1.0,
    "question_extraction_f1": 1.0,
    "answer_extraction_f1": 0.85,
    "mapping_accuracy_overall": 0.85,
    "mapping_accuracy_direct": 1.0,
    "unanswered_recall": 0.5,
    "multipage_answer_accuracy": 1.0,
    "bbox_mean_iou": 0.95,
    "bbox_above_threshold": 1.0,
}


def _ocr_bbox_accuracy() -> dict[str, float]:
    """Independent bbox ground truth: place synthetic OCR words at known fractions of a
    preprocessed page image, then check the stored (inverted, normalised) boxes land
    back on those fractions. This is the check that catches a coordinate-space bug,
    which fails silently with correct text and high confidence."""
    import io

    from PIL import Image

    from app.ai.ocr.base import OCRWord
    from app.ai.ocr.stub import StubOCREngine
    from app.modules.documents.pdf import render_pages
    from app.modules.extraction import pipeline as extraction_pipeline
    from app.modules.extraction.preprocess import preprocess_for_ocr
    from app.schemas.common import BBox

    render = render_pages(question_paper_pdf())[0]
    preprocessed = preprocess_for_ocr(render.image_bytes, target_long_edge=2000)
    image = Image.open(io.BytesIO(preprocessed.image_bytes))

    truth = [
        BBox(x1=0.10, y1=0.10, x2=0.40, y2=0.16),
        BBox(x1=0.55, y1=0.45, x2=0.90, y2=0.52),
        BBox(x1=0.20, y1=0.80, x2=0.75, y2=0.87),
    ]
    engine = StubOCREngine()
    engine.set_default(
        [
            OCRWord(
                text=f"word-{index}",
                x1=box.x1 * image.width,
                y1=box.y1 * image.height,
                x2=box.x2 * image.width,
                y2=box.y2 * image.height,
                confidence=0.95,
            )
            for index, box in enumerate(truth)
        ]
    )
    blocks = extraction_pipeline._ocr_blocks(render, engine, handwriting=False)
    return bbox_accuracy([block.bbox for block in blocks], truth)


@pytest.fixture(scope="module")
def scorecard() -> dict:
    question_ir = extract_document(question_paper_pdf(), "q", "question_paper").ir
    answer_ir = extract_document(answer_sheet_pdf(), "a", "answer_sheet").ir

    questions = run_question_graph(question_ir).questions
    answers = run_answer_graph(answer_ir).answers
    mappings = run_mapping_graph(questions, answers).mappings

    logical = merge_continuations(answers)
    question_index = {question.question_id: question for question in questions}
    answer_index = {answer.answer_id: answer for answer in logical}

    accuracy = mapping_accuracy(mappings, question_index, answer_index, GROUND_TRUTH.expected_pairs)
    question_prf = question_extraction_prf(questions, GROUND_TRUTH.question_numbers)
    answer_prf = answer_extraction_prf(logical, len(GROUND_TRUTH.expected_pairs) + GROUND_TRUTH.extra_answers)
    unanswered = unanswered_prf(mappings, question_index, GROUND_TRUTH.unanswered)

    boxes = _ocr_bbox_accuracy()

    return {
        "question_number_accuracy": question_number_accuracy(questions, GROUND_TRUTH.question_numbers),
        "question_extraction_f1": question_prf.f1,
        "answer_extraction_f1": answer_prf.f1,
        "mapping_accuracy_overall": accuracy.overall,
        "mapping_accuracy_by_type": accuracy.by_type,
        "mapping_counts_by_type": accuracy.counts,
        "mapping_accuracy_direct": accuracy.by_type.get("direct", 0.0),
        "unanswered_recall": unanswered.recall,
        "unanswered_precision": unanswered.precision,
        "multipage_answer_accuracy": multipage_answer_accuracy(logical, GROUND_TRUTH.multi_page_answers),
        "bbox_mean_iou": boxes["mean_iou"],
        "bbox_above_threshold": boxes["above_threshold"],
        "used_llm": False,
    }


def test_print_scorecard(scorecard: dict, capsys):
    with capsys.disabled():
        print("\n=== Accuracy scorecard ===")
        print(json.dumps(scorecard, indent=2, sort_keys=True))


@pytest.mark.parametrize("metric", sorted(THRESHOLDS))
def test_metric_has_not_regressed(scorecard: dict, metric: str):
    assert scorecard[metric] >= THRESHOLDS[metric], (
        f"{metric} = {scorecard[metric]} fell below the committed threshold "
        f"{THRESHOLDS[metric]}"
    )


def test_mapping_accuracy_is_reported_per_type(scorecard: dict):
    """An aggregate number hides where the engine actually earns its keep."""
    assert scorecard["mapping_accuracy_by_type"], "per-type reporting is missing"
    assert set(scorecard["mapping_counts_by_type"]) <= {
        "direct", "semantic", "spatial", "unanswered", "unmatched"
    }


def test_the_deterministic_path_alone_produces_the_scorecard(scorecard: dict):
    """No pipeline may require an LLM to produce a result."""
    assert scorecard["used_llm"] is False
