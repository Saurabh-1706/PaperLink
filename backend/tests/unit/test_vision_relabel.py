"""U9 — the vision stage must re-derive the label from the text it just corrected.

Labels are parsed in `extract_answers`, from raw OCR, before this stage runs
(answer_graph.py:17). The vision model routinely restores the exact characters the
label parser needs, so without a re-read the recovered label is discarded and the
answer reaches the mapping engine with `detected_label=None` — the strongest signal
`mapping_engine/stages.py` has.
"""
from __future__ import annotations

import io

import pytest

from app.ai.llm.base import DocumentVisionProvider
from app.modules.answer_pipeline.vision import validate_transcriptions
from app.schemas.common import BBox, Region
from app.schemas.pipeline import ExtractedAnswer


class _FakeVision(DocumentVisionProvider):
    """Returns a fixed correction per page, in the order the lines were sent."""

    name = "fake"

    def __init__(self, corrections: list[str]) -> None:
        super().__init__()
        self._corrections = corrections
        self.calls = 0

    def transcribe(self, image_bytes: bytes, ocr_text: str) -> str | None:  # pragma: no cover
        return None

    def structure_blocks(self, prompt: str, schema: dict) -> dict | None:  # pragma: no cover
        return None

    def transcribe_page(
        self,
        image_bytes: bytes,
        ocr_lines: list[str],
        confidences: list[float] | None = None,
    ) -> list[str] | None:
        self.calls += 1
        return self._corrections


def _png() -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def _answer(answer_id: str, raw: str, label: str | None = None) -> ExtractedAnswer:
    return ExtractedAnswer(
        answer_id=answer_id,
        raw_text=raw,
        normalized_text=raw,
        detected_label=label,
        page_numbers=[1],
        regions=[Region(page=1, bbox=BBox(x1=0.1, y1=0.1, x2=0.9, y2=0.2))],
        confidence=0.30,
    )


def _run(answers, corrections):
    provider = _FakeVision(corrections)
    out, used = validate_transcriptions(
        answers, {1: _png()}, provider, [a.answer_id for a in answers]
    )
    assert used is True
    return out


@pytest.mark.parametrize(
    "raw,corrected,expected",
    [
        ("lns10 5 (R) ard y", "5. (B) ii, iii and v", "5"),
        ("X- lirred geceue Joait ayzp ou", "4. (C) X-linked recessive trait", "4"),
        ("@) 23S 9IRNA", "1. (D) 23S rRNA", "1"),
        ("8 (B) ard m", "12. (A) Both A & R are true", "12"),
    ],
)
def test_label_is_recovered_from_the_corrected_text(raw, corrected, expected):
    """The exact failure seen end-to-end: perfect correction, label thrown away."""
    out = _run([_answer("a-1", raw)], [corrected])
    assert out[0].detected_label == expected
    assert out[0].normalized_text == corrected


def test_a_correction_with_no_label_does_not_erase_an_existing_one():
    """Only ever an upgrade — this must not undo a label the OCR got right."""
    out = _run([_answer("a-1", "16 the mitochondria", label="16")], ["the mitochondria"])
    assert out[0].detected_label == "16"


def test_a_better_label_replaces_a_worse_one():
    """The corrected text is the more reliable source, so it wins when it parses."""
    out = _run([_answer("a-1", "l6. (A) x", label="6")], ["16. (A) x"])
    assert out[0].detected_label == "16"


def test_mcq_option_is_still_not_read_as_a_sub_part_after_correction():
    """U8 must hold on the corrected text too, not just the raw OCR."""
    out = _run([_answer("a-1", "8 (B) ard m")], ["8 (B) and more text"])
    assert out[0].detected_label == "8"


def test_uncorrected_answers_are_returned_untouched():
    answers = [_answer("a-1", "something"), _answer("a-2", "other")]
    provider = _FakeVision(["", ""])
    out, used = validate_transcriptions(answers, {1: _png()}, provider, ["a-1", "a-2"])
    assert used is False
    assert [a.detected_label for a in out] == [None, None]
