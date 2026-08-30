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


def test_numbered_points_inside_one_answer_stay_in_a_single_segment():
    """A long answer written as a numbered list ("1. ... 2. ... 3. ...") parses each
    point exactly like a question label -- without run-detection each point would
    fragment into its own answer and compete against unrelated questions in the
    mapping engine."""
    document = _document(
        [
            _page(
                1,
                [
                    ("5. The car accelerates uniformly for several reasons:", 0.10),
                    ("1. The velocity increases at a constant rate.", 0.14),
                    ("2. The acceleration graph is a horizontal line.", 0.18),
                    ("3. The displacement grows as the square of time.", 0.22),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert len(result.answers) == 1
    assert result.answers[0].detected_label == "5"
    assert "square of time" in result.answers[0].raw_text


def test_a_lone_backward_label_is_not_mistaken_for_a_point():
    """A single backward jump with nothing else following it in sequence must stay a
    real, separately-labelled answer -- only a genuine RUN of 2+ consecutive labels
    climbing 1, 2, 3... is a point list. This is the out-of-order case
    (`test_out_of_order_answers_are_not_reordered_by_the_pipeline`) plus enough
    trailing points-shaped text to prove a lone "1." after a real "5." still counts,
    as long as nothing continues the sequence."""
    document = _document(
        [
            _page(
                1,
                [
                    ("5. main answer text goes here for the question.", 0.10),
                    ("1. a genuinely separate, out-of-order answer to question one.", 0.90),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert [answer.detected_label for answer in result.answers] == ["5", "1"]


def test_numbered_points_split_across_pages_still_merge_into_one_answer():
    """The same point-list fragmentation, but the list itself is split by a page
    break -- this is the reported bug: a long point-form answer spanning pages was
    not mapping as one complete answer, because the continuing page's first point
    parsed a (wrong) label, which blocks the cross-page continuation link.

    Spacing stays uniform throughout (not one big jump to the bottom margin): a
    point list wrapping onto a second page looks like several tightly-spaced lines
    running down to the bottom, not an isolated large gap -- and the segmentation
    gap threshold is sensitive to exactly that distinction (see `_classify_labels`'s
    per-run gap check)."""
    document = _document(
        [
            _page(
                1,
                [
                    ("5. The car accelerates uniformly for several reasons:", 0.10),
                    ("1. The velocity increases at a constant rate throughout.", 0.18),
                    ("2. The acceleration graph is a horizontal line because", 0.26),
                    ("the acceleration stays constant throughout the whole motion", 0.34),
                    ("of the vehicle so equal changes of velocity happen in equal", 0.42),
                    ("intervals of time and the displacement grows as the square", 0.50),
                    ("of the elapsed time which is why the displacement time graph", 0.58),
                    ("is a parabola opening upward from the origin of the axes and", 0.66),
                    ("the area under the velocity time graph gives the total", 0.74),
                    ("displacement covered by the car during that whole interval", 0.82),
                    ("of time while the slope gives the constant acceleration value", 0.90),
                ],
            ),
            _page(
                2,
                [
                    ("that the whole question asks about in this particular case.", 0.06),
                    ("3. The displacement grows as the square of the elapsed time.", 0.14),
                    ("4. The area under the graph gives the total displacement.", 0.22),
                ],
            ),
        ]
    )
    result = extract_answers(document)
    continuation = next(a for a in result.answers if a.is_continuation_of)
    assert continuation.detected_label is None
    assert continuation.is_continuation_of == result.answers[0].answer_id

    merged = merge_continuations(result.answers)
    logical = next(a for a in merged if a.detected_label == "5")
    assert logical.page_numbers == [1, 2]
    assert "constant acceleration value" in logical.raw_text  # last line of page 1
    assert "total displacement" in logical.raw_text  # point 4, on page 2


def test_lettered_and_roman_points_also_stay_in_a_single_segment():
    """The same point-list fragmentation, but written with letters or roman numerals
    instead of digits -- these have no sheet-wide "expected direction" the way
    question numbers do, so they need a different suspicion signal (see
    `_classify_labels`): starting at the natural beginning of the sequence (a/i)
    with a tight gap, not a backward step."""
    lettered = _document(
        [
            _page(
                1,
                [
                    ("5. main answer text has several reasons for this overall:", 0.10),
                    ("a) first lettered point about the topic here", 0.14),
                    ("b) second lettered point about the topic here", 0.18),
                    ("c) third lettered point about the topic here", 0.22),
                ],
            )
        ]
    )
    result = extract_answers(lettered)
    assert len(result.answers) == 1
    assert result.answers[0].detected_label == "5"

    roman = _document(
        [
            _page(
                1,
                [
                    ("7. main answer text has several parts to it overall:", 0.10),
                    ("i) first roman point about the topic here", 0.14),
                    ("ii) second roman point about the topic here", 0.18),
                    ("iii) third roman point about the topic here", 0.22),
                ],
            )
        ]
    )
    result = extract_answers(roman)
    assert len(result.answers) == 1
    assert result.answers[0].detected_label == "7"


def test_genuine_bare_sub_part_answers_stay_separate():
    """A bare "a)", "b)" pair with real paragraph separation between them (not a
    tight list) must stay separate, real, differently-labelled answers -- the same
    ambiguity as the numeric out-of-order case, resolved the same way: a lone
    suspicious-looking label with no gap-backed run following it is left alone."""
    document = _document(
        [
            _page(
                1,
                [
                    ("5. Define the following terms and explain each in detail.", 0.05),
                    (
                        "a) Refractive index is the ratio of the speed of light in "
                        "vacuum to its speed in the medium, explained at some length.",
                        0.10,
                    ),
                    (
                        "b) Total internal reflection happens when the angle of "
                        "incidence exceeds the critical angle, explained at length too.",
                        0.90,
                    ),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert [answer.detected_label for answer in result.answers] == ["5", "a", "b"]


def test_lettered_points_split_mid_list_across_pages_still_merge_completely():
    """A point list that wraps onto a new page starting MID-sequence ("c)"
    continuing "a), b)" from the page before, not restarting at "a)") is the harder
    version of the reported bug: on the new page alone, "c)" doesn't look like the
    start of a list (its ordinal isn't 0), so recognising it as a continuing point
    requires remembering where the previous page's point run left off
    (`_LastRealTop.last_point`)."""
    document = _document(
        [
            _page(
                1,
                [
                    ("5. main text has several parts to explain in detail here:", 0.10),
                    ("a) first point about the topic overall in general terms", 0.18),
                    ("b) second point continues the explanation further along", 0.26),
                    ("with more supporting detail that keeps the line going on", 0.34),
                    ("and further still until it reaches near the page bottom", 0.42),
                    ("with even more detail continuing down the page here now", 0.50),
                    ("and yet more text filling out the rest of this long point", 0.58),
                    ("still going because the answer is quite long and detailed", 0.66),
                    ("nearly there now just a little further down the page still", 0.74),
                    ("almost at the bottom margin of the page at this point here", 0.82),
                    ("right at the edge of the page near the very bottom margin", 0.90),
                ],
            ),
            _page(
                2,
                [
                    ("continuing the second point onto the next page right here", 0.06),
                    ("c) third point begins here on the second page overall", 0.14),
                    ("d) fourth point begins here on the second page as well", 0.22),
                ],
            ),
        ]
    )
    result = extract_answers(document)
    merged = merge_continuations(result.answers)
    logical = next(a for a in merged if a.detected_label == "5")
    assert logical.page_numbers == [1, 2]
    assert "third point begins here" in logical.raw_text
    assert "fourth point begins here" in logical.raw_text


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


def test_same_page_split_without_a_cue_stays_separate():
    """Margin alignment alone must not be enough to merge — most handwritten answers
    share the same left margin whether or not they are the same answer, so without an
    explicit continuation cue this must be left as two independent candidates."""
    document = _document(
        [
            _page(
                1,
                [
                    ("11. the answer starts here", 0.10),
                    ("and continues for a line", 0.14),
                    ("a genuinely different later answer", 0.40),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert len(result.answers) == 2
    assert result.answers[1].is_continuation_of is None


def test_same_page_split_with_an_explicit_cue_is_linked_and_merges():
    """A student who writes "contd." at the end of a segment is giving an explicit,
    unambiguous signal — that is enough to link (and, on merge, fold together) a
    same-page split that plain geometry alone must not touch."""
    document = _document(
        [
            _page(
                1,
                [
                    ("11. the answer starts here", 0.10),
                    ("and continues normally contd.", 0.14),
                    ("the rest of the same answer resumes", 0.40),
                ],
            )
        ]
    )
    result = extract_answers(document)
    assert len(result.answers) == 2
    continuation = next(a for a in result.answers if a.is_continuation_of)
    assert continuation.is_continuation_of == result.answers[0].answer_id

    merged = merge_continuations(result.answers)
    logical = next(a for a in merged if a.detected_label == "11")
    assert "resumes" in logical.raw_text


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
