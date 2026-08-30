"""Ground-truth transcriptions for the OCR quality harness (docs/10-ocr-upgrade-plan.md).

Separate from `generator.py`'s `GROUND_TRUTH`, which is *structural* truth (which
question numbers exist, which answer maps where). This module is *textual* truth: the
exact characters a perfect recogniser would return. The two answer different questions
and regress independently — a pipeline can map every answer correctly while its
transcription quietly degrades.

The synthetic entry derives its text from `generator.ANSWER_PAGES` rather than
restating it, so the fixture and the document can never drift apart — the same
guarantee `generator.py` gives by generating rather than committing binaries.

Real scanned papers are added by dropping the PDF in `data/` and writing its
transcription into `SCANNED_GROUND_TRUTH` under the same fixture id. Nothing else in
the harness changes; `available_scanned_fixtures()` is what the tests skip on.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from tests.fixtures import generator

# backend/tests/fixtures/ocr_ground_truth.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"


@dataclass(frozen=True)
class OCRGroundTruth:
    """One fixture's expected transcription.

    `lines` is kept alongside `text` because the two catch different failures: `text`
    scores recognition, `lines` scores line grouping — a recogniser that reads every
    character correctly but merges two lines has a near-zero CER and a broken IR.
    """

    fixture_id: str
    lines: list[str] = field(default_factory=list)
    handwriting: bool = False

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def _lines_from_pages(pages: list[list[str]]) -> list[str]:
    """Blank strings in the generator are vertical spacing, not content."""
    return [line for page in pages for line in page if line.strip()]


SYNTHETIC_GROUND_TRUTH: dict[str, OCRGroundTruth] = {
    "synthetic_answer_sheet": OCRGroundTruth(
        fixture_id="synthetic_answer_sheet",
        lines=_lines_from_pages(generator.ANSWER_PAGES),
    ),
    "synthetic_question_paper": OCRGroundTruth(
        fixture_id="synthetic_question_paper",
        lines=_lines_from_pages(generator.QUESTION_PAGES),
    ),
}

SYNTHETIC_BUILDERS = {
    "synthetic_answer_sheet": generator.answer_sheet_pdf,
    "synthetic_question_paper": generator.question_paper_pdf,
}

# Real papers, present only on machines that have them. Declared unconditionally so the
# harness reads the same on every box; existence is checked, never assumed.
SCANNED_FIXTURES: dict[str, Path] = {
    "biology_answer_sheet": DATA_DIR / "Biology-1-5.pdf",
    "biology_question_paper": DATA_DIR / "question-paper.pdf",
}

# Page 4 of the Biology answer sheet, transcribed by eye on 2026-08-30.
#
# One page, not five, and that is deliberate: it is enough to produce a real CER for
# handwriting, and a wrong transcription is worse than none because every later phase
# is scored against it. The writer's letterforms are idiosyncratic (word-final "n"
# reads as "rr", "th" as "Pr"), so the transcription records the *intended* text --
# which is what grading needs -- rather than the glyph shapes.
#
# Page indices are 1-based to match IRPage.page_number.
BIOLOGY_PAGE_4_LINES: list[str] = [
    "SECTION - B",
    "17. (a) 6 phosphodiester bonds are present in the double stranded",
    "polynucleotide chain.",
    "b) * 10 base pairs are present in each helical turn",
    "* Distance between 2 base pairs = 0.34 nm = 3.4 A°",
    "c) * In addition to H-bonds the stacking of base pairs one",
    "over the other in a double helix confers additional stability.",
    "* The presence of Thymine also confers additional stability.",
    "18.",
    "a) * Restrictions are imposed on MTP in India to check the",
    "illegal female foeticide which is said to be relatively high",
    "in our country.",
]

# The page of the scanned fixture the transcription covers.
SCANNED_GROUND_TRUTH_PAGE = 4

# A fixture with a PDF but no ground truth is still useful — it yields flagged-line
# counts and timings, just no CER.
SCANNED_GROUND_TRUTH: dict[str, OCRGroundTruth] = {
    "biology_answer_sheet_p4": OCRGroundTruth(
        fixture_id="biology_answer_sheet_p4",
        lines=BIOLOGY_PAGE_4_LINES,
        handwriting=True,
    ),
}


def available_scanned_fixtures() -> dict[str, Path]:
    return {name: path for name, path in SCANNED_FIXTURES.items() if path.is_file()}


def ground_truth(fixture_id: str) -> OCRGroundTruth | None:
    return SYNTHETIC_GROUND_TRUTH.get(fixture_id) or SCANNED_GROUND_TRUTH.get(fixture_id)


__all__ = [
    "DATA_DIR",
    "OCRGroundTruth",
    "SCANNED_FIXTURES",
    "SCANNED_GROUND_TRUTH",
    "SCANNED_GROUND_TRUTH_PAGE",
    "SYNTHETIC_BUILDERS",
    "SYNTHETIC_GROUND_TRUTH",
    "available_scanned_fixtures",
    "ground_truth",
]
