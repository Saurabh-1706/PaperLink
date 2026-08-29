"""Grading: deterministic rules first, LLM rubric scoring only for open-ended answers.

A mapping in `needs_review` is never graded — a confidently wrong mark is worse than an
unscored one (docs/pipelines/grading.md).
"""
from __future__ import annotations

from app.ai.llm.base import LLMProvider
from app.ai.prompts.grading import GRADING_SCHEMA, build_grading_prompt
from app.core.logging import get_logger
from app.modules.mapping_engine.similarity import tokenize
from app.schemas.common import MappingType, ReviewStatus
from app.schemas.pipeline import (
    CriterionScore,
    ExtractedAnswer,
    ExtractedQuestion,
    Grade,
    Mapping,
    Rubric,
)

log = get_logger(__name__)

DEFAULT_MAX_MARKS = 1.0


def grade_assessment(
    mappings: list[Mapping],
    questions: dict[str, ExtractedQuestion],
    answers: dict[str, ExtractedAnswer],
    rubrics: dict[str, Rubric] | None = None,
    llm: LLMProvider | None = None,
) -> list[Grade]:
    rubrics = rubrics or {}
    grades: list[Grade] = []
    for mapping in mappings:
        grade = grade_mapping(mapping, questions, answers, rubrics.get(mapping.question_id or ""), llm)
        if grade is not None:
            grades.append(grade)
    return grades


def grade_mapping(
    mapping: Mapping,
    questions: dict[str, ExtractedQuestion],
    answers: dict[str, ExtractedAnswer],
    rubric: Rubric | None = None,
    llm: LLMProvider | None = None,
) -> Grade | None:
    if mapping.question_id is None:
        return None  # an unmatched extra answer scores nothing
    question = questions.get(mapping.question_id)
    if question is None:
        return None
    max_marks = question.max_marks or DEFAULT_MAX_MARKS

    # The review gate.
    if mapping.review_status == ReviewStatus.NEEDS_REVIEW and mapping.mapping_type != MappingType.UNANSWERED:
        return Grade(
            question_id=mapping.question_id,
            answer_id=mapping.answer_id,
            score=0.0,
            max_score=max_marks,
            method="skipped",
            skipped_reason="mapping_needs_review",
            feedback="Held for review: the answer assigned to this question is uncertain.",
        )

    answer = answers.get(mapping.answer_id or "")
    if mapping.mapping_type == MappingType.UNANSWERED or answer is None or not answer.normalized_text.strip():
        return Grade(
            question_id=mapping.question_id,
            answer_id=mapping.answer_id,
            score=0.0,
            max_score=max_marks,
            method="deterministic",
            feedback="No answer was found for this question.",
        )

    if rubric and rubric.criteria and any(criterion.keywords for criterion in rubric.criteria):
        return _keyword_grade(question, answer, rubric, max_marks)

    if llm is not None:
        graded = _llm_grade(question, answer, rubric, max_marks, llm)
        if graded is not None:
            return graded

    return _fallback_grade(question, answer, max_marks)


def _keyword_grade(
    question: ExtractedQuestion, answer: ExtractedAnswer, rubric: Rubric, max_marks: float
) -> Grade:
    tokens = set(tokenize(answer.normalized_text))
    total_weight = sum(criterion.weight for criterion in rubric.criteria) or 1.0
    breakdown: list[CriterionScore] = []
    score = 0.0
    for criterion in rubric.criteria:
        criterion_max = criterion.max_marks or max_marks * (criterion.weight / total_weight)
        keywords = [keyword.lower() for keyword in criterion.keywords]
        hits = sum(1 for keyword in keywords if any(keyword in token or token in keyword for token in tokens))
        ratio = hits / len(keywords) if keywords else 0.0
        awarded = round(criterion_max * ratio, 2)
        score += awarded
        breakdown.append(
            CriterionScore(
                name=criterion.name,
                awarded=awarded,
                max_marks=round(criterion_max, 2),
                rationale=f"matched {hits}/{len(keywords)} rubric terms",
            )
        )
    return Grade(
        question_id=question.question_id,
        answer_id=answer.answer_id,
        score=round(min(score, max_marks), 2),
        max_score=max_marks,
        breakdown=breakdown,
        method="deterministic",
        feedback=_feedback_from_breakdown(breakdown),
    )


def _llm_grade(
    question: ExtractedQuestion,
    answer: ExtractedAnswer,
    rubric: Rubric | None,
    max_marks: float,
    llm: LLMProvider,
) -> Grade | None:
    criteria = [(criterion.name, criterion.weight) for criterion in (rubric.criteria if rubric else [])]
    prompt = build_grading_prompt(question.text, answer.normalized_text, max_marks, criteria)
    result = llm.complete_json(prompt, GRADING_SCHEMA)
    if not result or "score" not in result:
        return None
    try:
        score = float(result["score"])
    except (TypeError, ValueError):
        return None
    breakdown = [
        CriterionScore(
            name=str(item.get("name", "criterion")),
            awarded=float(item.get("awarded", 0)),
            max_marks=float(item.get("max_marks", 0)),
            rationale=str(item.get("rationale", "")),
        )
        for item in result.get("breakdown", [])
        if isinstance(item, dict)
    ]
    return Grade(
        question_id=question.question_id,
        answer_id=answer.answer_id,
        score=round(max(0.0, min(score, max_marks)), 2),
        max_score=max_marks,
        breakdown=breakdown,
        method="llm",
        feedback=str(result.get("feedback", ""))[:1000],
    )


def _fallback_grade(question: ExtractedQuestion, answer: ExtractedAnswer, max_marks: float) -> Grade:
    """Deterministic last resort: coverage of the question's own content words."""
    question_tokens = set(tokenize(question.text))
    answer_tokens = set(tokenize(answer.normalized_text))
    coverage = len(question_tokens & answer_tokens) / len(question_tokens) if question_tokens else 0.0
    score = round(max_marks * min(1.0, coverage * 1.5), 2)
    return Grade(
        question_id=question.question_id,
        answer_id=answer.answer_id,
        score=score,
        max_score=max_marks,
        method="deterministic",
        feedback=(
            "Scored without a rubric or model: the mark reflects overlap with the "
            "question's key terms and should be confirmed by a teacher."
        ),
    )


def _feedback_from_breakdown(breakdown: list[CriterionScore]) -> str:
    missing = [item.name for item in breakdown if item.awarded < item.max_marks * 0.5]
    if not missing:
        return "All rubric criteria were addressed."
    return "Weak or missing coverage of: " + ", ".join(missing) + "."


def assessment_summary(grades: list[Grade]) -> dict[str, float | int]:
    scored = [grade for grade in grades if grade.method != "skipped"]
    total = sum(grade.score for grade in scored)
    possible = sum(grade.max_score for grade in scored)
    return {
        "graded_count": len(scored),
        "held_for_review": len(grades) - len(scored),
        "total_score": round(total, 2),
        "max_score": round(possible, 2),
        "percentage": round(100 * total / possible, 2) if possible else 0.0,
    }
