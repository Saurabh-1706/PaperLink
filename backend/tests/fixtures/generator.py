"""Synthetic fixture documents.

Deliberately weighted toward the awkward cases the design claims to handle: nested
numbering, an out-of-order answer, a two-page answer, a blank question and an extra
answer that maps to nothing. Generated rather than committed as binaries so the
ground truth and the document can never drift apart.
"""
from __future__ import annotations

from dataclasses import dataclass, field

LEFT = 60
TOP = 80
LINE_HEIGHT = 34
FONT_SIZE = 11


@dataclass
class GroundTruth:
    question_numbers: list[str] = field(default_factory=list)
    expected_pairs: dict[str, str] = field(default_factory=dict)   # normalized_number -> answer label
    unanswered: list[str] = field(default_factory=list)
    multi_page_answers: list[str] = field(default_factory=list)
    extra_answers: int = 0


QUESTION_PAGES: list[list[str]] = [
    [
        "Physics Examination 2026",
        "Answer all questions unless stated otherwise.",
        "1. Define velocity and state its SI unit. [2 marks]",
        "2. Explain Newton's second law of motion with one example. [5 marks]",
        "3. What is the difference between mass and weight? [3 marks]",
        "4. State the law of conservation of energy. [2 marks]",
    ],
    [
        "5. A car accelerates uniformly from rest. Describe its motion graph. [4 marks]",
        "11 (a) Define refractive index of a medium. [3 marks]",
        "11 (b) Explain total internal reflection with a diagram. [5 marks]",
        "12. Attempt any one of the following optional parts. [5 marks]",
    ],
]

ANSWER_PAGES: list[list[str]] = [
    [
        "1. Velocity is displacement per unit time, measured in metres per second.",
        "",
        "3. Mass is the quantity of matter in a body while weight is the force of",
        "gravity acting on that mass, measured in newtons.",
        "",
        "2. Newton's second law states that force equals mass times acceleration.",
        "For example a heavier trolley needs more force for the same acceleration.",
        "",
        "11 (a) Refractive index is the ratio of the speed of light in vacuum to the",
        "speed of light in the medium.",
        "",
        "5. The car's velocity time graph is a straight line of positive slope",
        "starting from the origin, and the acceleration graph is a horizontal line",
        "because the acceleration stays constant throughout the whole motion of",
        "the vehicle, so equal changes of velocity happen in equal intervals of",
        "time and the displacement grows as the square of the elapsed time, which",
        "is why the displacement time graph is a parabola opening upwards from",
        "the origin of the axes, and the area under the velocity time graph gives",
        "the total displacement covered by the car during that interval of time,",
        "while the slope of the same graph gives the constant acceleration value",
        "that the question asks about, and this continues on the next page where",
    ],
    [
        "the car as it moves along the straight road without any braking at all.",
        "",
        "11 (b) Total internal reflection happens when light travels from a denser",
        "medium to a rarer medium beyond the critical angle and reflects back.",
        "",
        "",
        "A note about the diagram which was drawn on the reverse side of the sheet.",
    ],
]

GROUND_TRUTH = GroundTruth(
    question_numbers=["1", "2", "3", "4", "5", "11.a", "11.b", "12"],
    expected_pairs={"1": "1", "2": "2", "3": "3", "5": "5", "11.a": "11.a", "11.b": "11.b"},
    unanswered=["4", "12"],
    multi_page_answers=["5"],
    extra_answers=1,
)


def build_pdf(pages: list[list[str]]) -> bytes:
    import pymupdf

    document = pymupdf.open()
    for lines in pages:
        page = document.new_page(width=595, height=842)  # A4 in points
        y = TOP
        for line in lines:
            if line:
                page.insert_text((LEFT, y), line, fontsize=FONT_SIZE, fontname="helv")
            y += LINE_HEIGHT
        # A long gap before the page footer keeps segmentation honest about whitespace.
    data = document.tobytes()
    document.close()
    return data


def question_paper_pdf() -> bytes:
    return build_pdf(QUESTION_PAGES)


def answer_sheet_pdf() -> bytes:
    return build_pdf(ANSWER_PAGES)
