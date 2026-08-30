"""Segmentation, continuation detection and normalisation."""
from __future__ import annotations

from app.modules.answer_pipeline.pipeline import (
    extract_answers,
    merge_continuations,
    normalize_text,
)
from app.schemas.common import BBox, ExtractionMethod, PageClassification
from app.schemas.ir import IRBlock, IRDocument, IRPage


def _page(page_number: int, lines: list[tuple[str, float]]) -> IRPage:
    blocks = [
        IRBlock(
            block_id=f"p{page_number}-{index}",
            text=text,
            bbox=BBox(x1=0.1, y1=y, x2=0.9, y2=y + 0.03),
            confidence=0.8,
            reading_order=index,
        )
        for index, (text, y) in enumerate(lines)
    ]
    return IRPage(
        page_number=page_number,
        width=595,
        height=842,
        dpi=300,
        classification=PageClassification.SCANNED,
        extraction_method=ExtractionMethod.OCR,
        blocks=blocks,
    )


def _document(pages: list[IRPage]) -> IRDocument:
    return IRDocument(document_id="a", kind="answer_sheet", page_count=len(pages), pages=pages)


def test_labels_start_new_segments():
    document = _document(
        [
            _page(
                1,
                [
                    ("1. Velocity is displacement per unit time.", 0.10),
                    ("2. Force equals mass times acceleration.", 0.16),
                    ("It follows from the second law.", 0.20),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert [answer.detected_label for answer in result.answers] == ["1", "2"]
    assert "second law" in result.answers[1].raw_text


def test_whitespace_gap_starts_a_segment_without_a_label():
    document = _document(
        [
            _page(
                1,
                [
                    ("first unlabelled answer line one", 0.10),
                    ("first unlabelled answer line two", 0.14),
                    ("a completely separate later answer", 0.40),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert len(result.answers) == 2
    assert result.answers[0].detected_label is None


def test_out_of_order_answers_are_not_reordered_by_the_pipeline():
    document = _document(
        [_page(1, [("3. third answer text", 0.10), ("1. first answer text", 0.30)])]
    )
    result = extract_answers(document)
    assert [answer.detected_label for answer in result.answers] == ["3", "1"]


def test_continuation_links_and_merges_into_one_multi_region_answer():
    document = _document(
        [
            _page(1, [("5. the motion of the car continues", 0.70), ("further detail here", 0.92)]),
            _page(2, [("as it moves along the road", 0.06), ("11 (b) separate answer", 0.40)]),
        ]
    )
    result = extract_answers(document)
    continuation = next(a for a in result.answers if a.is_continuation_of)
    assert continuation.is_continuation_of == result.answers[0].answer_id

    merged = merge_continuations(result.answers)
    logical = next(a for a in merged if a.detected_label == "5")
    assert logical.page_numbers == [1, 2]
    assert len(logical.regions) == 2
    assert "moves along the road" in logical.raw_text


def test_blank_page_produces_no_segments():
    result = extract_answers(_document([_page(1, [])]))
    assert result.answers == []


def test_raw_text_is_preserved_while_normalized_text_is_cleaned():
    raw = "The  student’s  answer —  with   odd spacing"
    assert normalize_text(raw) == "The student's answer - with odd spacing"


def test_low_confidence_answers_are_flagged():
    page = _page(1, [("scribbled answer", 0.10)])
    page.blocks[0] = page.blocks[0].model_copy(update={"confidence": 0.3})
    result = extract_answers(_document([page]))
    assert result.low_confidence_answer_ids == [result.answers[0].answer_id]


# --------------------------------------------------------- U8: MCQ option letters
# On an answer sheet "8 (B) ..." is the student's chosen option, not sub-part b of Q8.
# The shared parser in labels.py cannot tell the two apart and must not be changed:
# on the QUESTION side "12 (a)" genuinely is a sub-part. These tests pin the answer-side
# override, and the last two pin what it must leave alone.

import pytest

from app.modules.answer_pipeline.pipeline import parse_answer_label
from app.modules.question_pipeline.labels import parse_label


@pytest.mark.parametrize(
    "text,expected",
    [
        ("8 (B) ard m", "8"),
        ("14 (B) Bom A", "14"),
        ("18 (A) CH3,C02, H2", "18"),
        ("Ans. 8 (B) foo", "8"),
        ("8. (B) real mcq", "8"),          # period present: already correct, stays correct
        ("Q12 (D) something", "12"),
    ],
)
def test_numbered_mcq_answer_keeps_the_question_number(text, expected):
    parsed = parse_answer_label(text)
    assert parsed is not None
    assert parsed.normalized == expected


@pytest.mark.parametrize("text", ["(B) 0.42", "(A) Boff A", "[C] 42"])
def test_bare_option_letter_is_not_a_label(text):
    """Inventing `b` fabricates a label with no top level that can never match a row."""
    assert parse_answer_label(text) is None


@pytest.mark.parametrize(
    "text,expected",
    [
        ("12 (a) mitosis is", "12.a"),     # lowercase = genuine sub-part
        ("(a) mitosis is", "a"),
        ("11(a)(ii) text here", "11.a.ii"),
        ("3) Calabelism", "3"),
        ("Q5 State the", "5"),
    ],
)
def test_genuine_sub_parts_are_untouched(text, expected):
    parsed = parse_answer_label(text)
    assert parsed is not None
    assert parsed.normalized == expected


def test_question_side_parser_is_unchanged():
    """labels.py is shared verbatim; the override must live on the answer side only."""
    assert parse_label("8 (B) ard m", allow_answer_prefix=True).normalized == "8.b"
    assert parse_label("(B) 0.42", allow_answer_prefix=True).normalized == "b"
