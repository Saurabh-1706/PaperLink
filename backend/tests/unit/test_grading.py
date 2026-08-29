"""Grading rules and the review gate."""
from __future__ import annotations

from app.modules.grading.engine import assessment_summary, grade_mapping
from app.schemas.common import MappingType, Region, ReviewStatus
from app.schemas.pipeline import (
    ExtractedAnswer,
    ExtractedQuestion,
    Mapping,
    MappingEvidence,
    Rubric,
    RubricCriterion,
)


def _question(marks: float | None = 4.0) -> ExtractedQuestion:
    return ExtractedQuestion(
        question_id="q-1",
        display_number="1",
        normalized_number="1",
        text="Explain Newton's second law of motion",
        pages=[1],
        regions=[Region(page=1, bbox=[0.1, 0.1, 0.9, 0.2])],
        order_index=0,
        max_marks=marks,
        confidence=1.0,
    )


def _answer(text: str = "force equals mass times acceleration") -> ExtractedAnswer:
    return ExtractedAnswer(
        answer_id="a-1",
        raw_text=text,
        normalized_text=text,
        page_numbers=[1],
        regions=[Region(page=1, bbox=[0.1, 0.3, 0.9, 0.4])],
        confidence=0.9,
    )


def _mapping(review: ReviewStatus, kind: MappingType = MappingType.DIRECT) -> Mapping:
    return Mapping(
        question_id="q-1",
        answer_id="a-1" if kind != MappingType.UNANSWERED else None,
        mapping_type=kind,
        confidence=0.9,
        review_status=review,
        regions=[],
        evidence=MappingEvidence(stage="label"),
    )


def test_needs_review_mapping_is_never_graded():
    grade = grade_mapping(
        _mapping(ReviewStatus.NEEDS_REVIEW),
        {"q-1": _question()},
        {"a-1": _answer()},
    )
    assert grade is not None
    assert grade.method == "skipped"
    assert grade.skipped_reason == "mapping_needs_review"
    assert grade.score == 0.0


def test_unanswered_scores_zero_deterministically():
    grade = grade_mapping(
        _mapping(ReviewStatus.AUTO_ACCEPTED, MappingType.UNANSWERED),
        {"q-1": _question()},
        {},
    )
    assert grade.score == 0.0
    assert grade.method == "deterministic"


def test_rubric_keywords_are_scored_without_a_model():
    rubric = Rubric(
        criteria=[
            RubricCriterion(name="states the law", weight=1, keywords=["force", "mass"]),
            RubricCriterion(name="gives an example", weight=1, keywords=["trolley", "example"]),
        ]
    )
    grade = grade_mapping(
        _mapping(ReviewStatus.AUTO_ACCEPTED), {"q-1": _question()}, {"a-1": _answer()}, rubric
    )
    assert grade.method == "deterministic"
    assert 0 < grade.score < grade.max_score
    assert [item.name for item in grade.breakdown] == ["states the law", "gives an example"]


def test_llm_failure_falls_back_to_a_deterministic_score():
    class FailingProvider:
        name = "failing"

        def complete_json(self, prompt, schema):
            return None

    grade = grade_mapping(
        _mapping(ReviewStatus.AUTO_ACCEPTED),
        {"q-1": _question()},
        {"a-1": _answer()},
        None,
        FailingProvider(),
    )
    assert grade.method == "deterministic"
    assert grade.max_score == 4.0


def test_unmatched_answer_is_not_graded():
    mapping = Mapping(
        question_id=None,
        answer_id="a-1",
        mapping_type=MappingType.UNMATCHED,
        confidence=0.0,
        review_status=ReviewStatus.NEEDS_REVIEW,
        evidence=MappingEvidence(stage="unmatched"),
    )
    assert grade_mapping(mapping, {}, {"a-1": _answer()}) is None


def test_summary_separates_graded_from_held():
    graded = grade_mapping(
        _mapping(ReviewStatus.AUTO_ACCEPTED), {"q-1": _question()}, {"a-1": _answer()}
    )
    held = grade_mapping(
        _mapping(ReviewStatus.NEEDS_REVIEW), {"q-1": _question()}, {"a-1": _answer()}
    )
    summary = assessment_summary([graded, held])
    assert summary["graded_count"] == 1
    assert summary["held_for_review"] == 1
