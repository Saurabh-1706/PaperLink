"""Label normalisation, hierarchy, marks and optional detection."""
from __future__ import annotations

import pytest

from app.modules.question_pipeline.labels import normalize_label, parent_of, parse_label, sort_key
from app.modules.question_pipeline.pipeline import extract_questions
from app.schemas.common import BBox, BlockType, ExtractionMethod, PageClassification
from app.schemas.ir import IRBlock, IRDocument, IRPage


@pytest.mark.parametrize("text", ["11 a) answer", "11(a) answer", "Q11a answer", "11 (a) answer"])
def test_label_variants_collapse_identically(text: str):
    assert normalize_label(text) == "11.a"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1. Define velocity", "1"),
        ("2) Explain", "2"),
        ("Q.5 State", "5"),
        ("10. Compare", "10"),
        ("(ii) Derive", "ii"),
        ("Ans 3: because", "3"),
        ("Answer 11(b) light", "11.b"),
    ],
)
def test_numbering_family(text: str, expected: str):
    assert normalize_label(text) == expected


def test_prose_is_not_a_label():
    assert parse_label("The velocity of the car is 5 m/s", allow_answer_prefix=True) is None


def test_display_number_is_preserved_verbatim():
    parsed = parse_label("11 (a) Define refractive index")
    assert parsed is not None
    assert parsed.display == "11 (a)"
    assert parsed.normalized == "11.a"


def test_parent_and_sort_order():
    assert parent_of("11.a.ii") == "11.a"
    assert parent_of("11") is None
    assert sorted(["11.a", "2", "11", "1.b"], key=sort_key) == ["1.b", "2", "11", "11.a"]


def _document(lines: list[str]) -> IRDocument:
    blocks = [
        IRBlock(
            block_id=f"b{index}",
            text=text,
            bbox=BBox(x1=0.1, y1=0.05 + index * 0.06, x2=0.9, y2=0.09 + index * 0.06),
            confidence=1.0,
            block_type=BlockType.LINE,
            reading_order=index,
        )
        for index, text in enumerate(lines)
    ]
    page = IRPage(
        page_number=1,
        width=595,
        height=842,
        dpi=300,
        classification=PageClassification.SEARCHABLE,
        extraction_method=ExtractionMethod.TEXT,
        blocks=blocks,
    )
    return IRDocument(document_id="d", kind="question_paper", page_count=1, pages=[page])


def test_nested_parts_become_separate_questions_sharing_a_parent():
    result = extract_questions(
        _document(
            [
                "11 (a) Define refractive index. [3 marks]",
                "11 (b) Explain total internal reflection. [5 marks]",
                "(i) State one application.",
            ]
        )
    )
    numbers = [question.normalized_number for question in result.questions]
    assert numbers == ["11.a", "11.b", "11.b.i"]
    assert result.questions[0].parent_number == "11"
    assert result.questions[2].parent_number == "11.b"


def test_marks_and_optional_detection():
    result = extract_questions(
        _document(
            [
                "1. Define velocity. [2 marks]",
                "2. Attempt any two of the following. (10)",
            ]
        )
    )
    assert result.questions[0].max_marks == 2
    assert result.questions[0].optional is False
    assert result.questions[1].optional is True


def test_gaps_are_flagged_as_ambiguities():
    result = extract_questions(_document(["1. First question here.", "3. Third question here."]))
    assert any(issue.startswith("gap_between_1_and_3") for issue in result.ambiguities)


def test_pipeline_needs_no_database_network_or_model():
    result = extract_questions(_document(["1. Define velocity."]))
    assert result.used_llm is False
    assert result.questions[0].regions[0].page == 1
