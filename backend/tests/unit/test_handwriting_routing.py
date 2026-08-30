"""Phase 5 wiring: LINE_SCRIPT_MODE=route sends handwritten lines to a LineRecognizer.

These exercise the pipeline seam, not the model. The recogniser is a stub, so what is
under test is the routing decision, the guard, and the invariant that matters most:
a re-read changes text and confidence and never touches a coordinate (ADR-001).
"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from app.ai.ocr import factory
from app.ai.ocr.base import OCRWord
from app.ai.ocr.recognizer import RecognizedLine, StubLineRecognizer
from app.ai.ocr.stub import StubOCREngine
from app.core.config import settings
from app.modules.documents.pdf import render_pages
from app.modules.extraction import pipeline as extraction_pipeline
from app.schemas.common import ScriptClass
from tests.fixtures.generator import question_paper_pdf


@pytest.fixture
def render():
    return render_pages(question_paper_pdf())[0]


@pytest.fixture
def handwriting_words():
    """Six fragments with the drifting baseline, varying heights and low confidence a
    print-trained recogniser produces on cursive — enough for the classifier to call it
    handwritten. Coordinates are in preprocessed-image pixel space."""
    drift = [0, 10, -7, 14, -12, 8]
    heights = [40, 58, 34, 66, 44, 62]
    widths = [70, 160, 55, 200, 90, 140]
    words = ["the", "mitochondria", "is", "powerhouse", "of", "cell"]
    out = []
    x = 200.0
    for index in range(6):
        top = 700.0 + drift[index]
        out.append(
            OCRWord(
                text=words[index],
                x1=x,
                y1=top,
                x2=x + widths[index],
                y2=top + heights[index],
                confidence=0.52,
            )
        )
        x += widths[index] + 26
    return out


@pytest.fixture
def routing(monkeypatch):
    """Turn routing on and install a stub recogniser, restoring both afterwards."""
    monkeypatch.setattr(settings, "line_script_mode", "route")
    recognizer = StubLineRecognizer()
    factory.set_line_recognizer(recognizer)
    yield recognizer
    factory.set_line_recognizer(None)


def _blocks(render, words):
    engine = StubOCREngine()
    engine.set_default(words)
    return extraction_pipeline._ocr_blocks(render, engine, handwriting=True)


def test_telemetry_mode_classifies_but_routes_nothing(render, handwriting_words, monkeypatch):
    monkeypatch.setattr(settings, "line_script_mode", "telemetry")
    factory.set_line_recognizer(StubLineRecognizer())
    try:
        blocks = _blocks(render, handwriting_words)
    finally:
        factory.set_line_recognizer(None)

    assert any(block.script is ScriptClass.HANDWRITTEN for block in blocks)
    # Classified, but nothing was re-read: that is the whole point of the mode.
    assert all(block.recognizer is None for block in blocks)


def test_off_mode_does_not_classify(render, handwriting_words, monkeypatch):
    monkeypatch.setattr(settings, "line_script_mode", "off")
    blocks = _blocks(render, handwriting_words)
    assert all(block.script is ScriptClass.UNCERTAIN for block in blocks)
    assert all(block.script_score == 0.0 for block in blocks)


def test_route_mode_replaces_text_but_never_the_bbox(render, handwriting_words, routing, monkeypatch):
    monkeypatch.setattr(settings, "line_script_mode", "telemetry")
    baseline = _blocks(render, handwriting_words)
    monkeypatch.setattr(settings, "line_script_mode", "route")

    routing.set_default(RecognizedLine(text="the mitochondria is powerhouse of cell", confidence=0.88))
    routed = _blocks(render, handwriting_words)

    replaced = [block for block in routed if block.recognizer is not None]
    assert replaced, "a handwritten low-confidence line should have been re-read"
    assert replaced[0].recognizer == "stub"
    assert replaced[0].text == "the mitochondria is powerhouse of cell"
    assert replaced[0].confidence == pytest.approx(0.88)

    # The invariant. Same boxes, in the same order, before and after the model ran.
    assert [b.bbox for b in routed] == [b.bbox for b in baseline]


def test_empty_recognizer_output_never_deletes_an_answer(render, handwriting_words, routing):
    """A failed decode returning "" must leave the OCR text standing — replacing it
    would silently drop the line out of answer segmentation."""
    routing.set_default(RecognizedLine(text="   ", confidence=0.99))
    blocks = _blocks(render, handwriting_words)
    assert all(block.recognizer is None for block in blocks)
    assert any(block.text.strip() for block in blocks)


def test_implausible_length_is_rejected(render, handwriting_words, routing):
    """The hallucination guard: a fluent invented paragraph is not a re-read."""
    routing.set_default(
        RecognizedLine(text="the mitochondria " * 40, confidence=0.99)
    )
    blocks = _blocks(render, handwriting_words)
    assert all(block.recognizer is None for block in blocks)


def test_recognizer_failure_falls_back_to_ocr_text(render, handwriting_words, monkeypatch):
    """No pipeline may *require* a model to produce a result."""
    monkeypatch.setattr(settings, "line_script_mode", "route")

    class Exploding(StubLineRecognizer):
        name = "exploding"

        def read(self, crops):
            raise RuntimeError("model unavailable")

    factory.set_line_recognizer(Exploding())
    try:
        blocks = _blocks(render, handwriting_words)
    finally:
        factory.set_line_recognizer(None)

    assert blocks, "extraction must still produce blocks"
    assert all(block.recognizer is None for block in blocks)


def test_no_recognizer_configured_is_a_no_op(render, handwriting_words, monkeypatch):
    monkeypatch.setattr(settings, "line_script_mode", "route")
    monkeypatch.setattr(settings, "line_recognizer", "none")
    factory.set_line_recognizer(None)
    blocks = _blocks(render, handwriting_words)
    assert all(block.recognizer is None for block in blocks)


def test_crop_comes_from_the_preprocessed_image(render, handwriting_words, routing):
    """The crop must be cut from the image the detector saw, in the detector's own
    pixel space — otherwise the recogniser is shown the wrong part of the page."""
    captured: list[bytes] = []

    class Capturing(StubLineRecognizer):
        name = "capturing"

        def read(self, crops):
            captured.extend(crops)
            return [RecognizedLine(text="", confidence=0.0) for _ in crops]

    factory.set_line_recognizer(Capturing())
    try:
        _blocks(render, handwriting_words)
    finally:
        factory.set_line_recognizer(None)

    assert captured, "a candidate line should have been cropped"
    crop = Image.open(io.BytesIO(captured[0]))
    # The synthetic line spans ~840px of width and ~80px of height plus padding.
    assert crop.width > crop.height, "a text line crop should be wider than it is tall"
    assert crop.width > 100
