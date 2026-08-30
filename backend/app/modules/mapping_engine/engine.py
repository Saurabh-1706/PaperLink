"""The mapping engine — the core deliverable.

Stages 1-5 build a question x answer score matrix; stage 6 solves it once; stage 7
turns the solution into outcome states. Generic LLM prompting is not responsible for
mapping: the LLM sees only the ambiguous band, with 2-3 candidates.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.ai.llm.base import LLMProvider
from app.ai.prompts.mapping import MAPPING_VALIDATION_SCHEMA, build_mapping_validation_prompt
from app.core.config import settings
from app.core.logging import get_logger
from app.modules.answer_pipeline.pipeline import merge_continuations
from app.modules.mapping_engine import assignment, stages
from app.modules.mapping_engine.stages import detect_label_offset, label_score_with_offset
from app.schemas.common import MappingType, ReviewStatus
from app.schemas.pipeline import (
    ExtractedAnswer,
    ExtractedQuestion,
    Mapping,
    MappingEvidence,
    MappingResult,
)

log = get_logger(__name__)

LLM_BOOST = 0.12


@dataclass(frozen=True)
class MappingConfig:
    use_labels: bool = True
    use_spatial: bool = True
    use_semantic: bool = True
    use_llm: bool = True
    accept_threshold: float = settings.mapping_accept_threshold
    review_threshold: float = settings.mapping_review_threshold
    ambiguous_margin: float = settings.mapping_ambiguous_margin
    weights: stages.StageWeights = stages.DEFAULT_WEIGHTS


def map_answers(
    questions: list[ExtractedQuestion],
    answers: list[ExtractedAnswer],
    config: MappingConfig | None = None,
    llm: LLMProvider | None = None,
) -> MappingResult:
    config = config or MappingConfig()
    # Continuation segments are merged before the solve, so a two-page answer competes
    # as one candidate rather than two.
    logical_answers = merge_continuations(answers)

    if not questions:
        return MappingResult(
            mappings=[_unmatched(answer) for answer in logical_answers], used_llm=False
        )

    question_rank = stages.build_ranks(stages.question_order(questions))
    answer_rank = stages.build_ranks(stages.answer_order(logical_answers))

    # U2 — detect numbering offset once before building the matrix.
    label_offset = detect_label_offset(questions, logical_answers)
    if label_offset:
        log.info("label offset detected", extra={"offset": label_offset})

    matrix: list[list[float]] = []
    detail: list[list[MappingEvidence]] = []
    for question in questions:
        row: list[float] = []
        row_detail: list[MappingEvidence] = []
        for answer in logical_answers:
            label = (
                label_score_with_offset(question, answer, label_offset)
                if config.use_labels else 0.0
            )
            spatial = (
                stages.spatial_score(question, answer, question_rank, answer_rank)
                if config.use_spatial
                else 0.0
            )
            semantic = stages.semantic_stage_score(question, answer) if config.use_semantic else 0.0
            combined = stages.combine(label, spatial, semantic, config.weights)
            row.append(combined)
            row_detail.append(
                MappingEvidence(
                    stage=_dominant_stage(label, spatial, semantic),
                    label_score=label,
                    spatial_score=spatial,
                    semantic_score=semantic,
                    combined_score=combined,
                )
            )
        matrix.append(row)
        detail.append(row_detail)

    used_llm = False
    if config.use_llm and llm is not None:
        used_llm = _llm_validate_ambiguous(questions, logical_answers, matrix, detail, config, llm)

    pairs = assignment.solve(matrix, reject_below=config.review_threshold)
    return _finalize(questions, logical_answers, matrix, detail, pairs, config, used_llm)


# ------------------------------------------------------------ stage 5: bounded LLM check
def _llm_validate_ambiguous(
    questions: list[ExtractedQuestion],
    answers: list[ExtractedAnswer],
    matrix: list[list[float]],
    detail: list[list[MappingEvidence]],
    config: MappingConfig,
    llm: LLMProvider,
) -> bool:
    """Called only where the top-1 score is not decisively above the runner-up."""
    used = False
    for row, question in enumerate(questions):
        scores = sorted(
            ((matrix[row][column], column) for column in range(len(answers))), reverse=True
        )
        if len(scores) < 2:
            continue
        top, runner_up = scores[0], scores[1]
        if top[0] <= 0.0:
            continue
        if top[0] >= config.accept_threshold and (top[0] - runner_up[0]) > config.ambiguous_margin:
            continue  # decisive: the LLM is not called at all
        if top[0] < config.review_threshold:
            continue  # nothing plausible enough to be worth a call

        candidate_columns = [column for _, column in scores[:3] if matrix[row][column] > 0]
        prompt = build_mapping_validation_prompt(
            question_text=f"{question.display_number} {question.text}",
            candidates=[
                (answers[column].answer_id, answers[column].normalized_text[:800])
                for column in candidate_columns
            ],
        )
        verdict = llm.complete_json(prompt, MAPPING_VALIDATION_SCHEMA)
        used = True
        if not verdict:
            continue
        chosen = verdict.get("answer_id")
        for column in candidate_columns:
            evidence = detail[row][column]
            if answers[column].answer_id == chosen:
                matrix[row][column] = min(0.98, matrix[row][column] + LLM_BOOST)
                detail[row][column] = evidence.model_copy(
                    update={
                        "llm_verdict": "selected",
                        "combined_score": matrix[row][column],
                        "notes": [*evidence.notes, str(verdict.get("reason", ""))[:200]],
                    }
                )
            else:
                detail[row][column] = evidence.model_copy(update={"llm_verdict": "rejected"})
    return used


# --------------------------------------------------------------- stage 7: outcome states
def _finalize(
    questions: list[ExtractedQuestion],
    answers: list[ExtractedAnswer],
    matrix: list[list[float]],
    detail: list[list[MappingEvidence]],
    pairs: list[tuple[int, int]],
    config: MappingConfig,
    used_llm: bool,
) -> MappingResult:
    mappings: list[Mapping] = []
    matched_rows: set[int] = set()
    matched_columns: set[int] = set()

    for row, column in pairs:
        question, answer = questions[row], answers[column]
        score = matrix[row][column]
        evidence = detail[row][column]
        runner_up = max(
            (
                (matrix[other][column], questions[other].question_id)
                for other in range(len(questions))
                if other != row
            ),
            default=(0.0, None),
        )
        evidence = evidence.model_copy(
            update={"runner_up_score": runner_up[0], "runner_up_question_id": runner_up[1]}
        )
        matched_rows.add(row)
        matched_columns.add(column)
        mappings.append(
            Mapping(
                question_id=question.question_id,
                answer_id=answer.answer_id,
                mapping_type=_mapping_type(evidence),
                confidence=score,
                review_status=(
                    ReviewStatus.AUTO_ACCEPTED
                    if score >= config.accept_threshold
                    else ReviewStatus.NEEDS_REVIEW
                ),
                regions=list(answer.regions),
                evidence=evidence,
            )
        )

    # Row -> the question that won each matched column, so a losing sibling can be told
    # who its answer went to instead of just looking blank.
    column_winner = {column: questions[row] for row, column in pairs}

    for row, question in enumerate(questions):
        if row in matched_rows:
            continue
        notes = ["no answer assigned"]
        review_status = ReviewStatus.AUTO_ACCEPTED if question.optional else ReviewStatus.NEEDS_REVIEW
        if question.parent_number:
            # A single answer labelled with just the parent number (e.g. "11") scores
            # equally against every sub-part 11.a/11.b/11.c, but the one-to-one
            # assignment can only give it to one of them. The siblings that lost the
            # race are not truly blank — flag them for manual review instead of
            # reporting a plain "no answer assigned" that looks like nothing was written.
            for column in matched_columns:
                if matrix[row][column] < config.review_threshold:
                    continue
                winner = column_winner[column]
                if winner.parent_number == question.parent_number:
                    notes = [
                        f"possible shared answer: question {winner.display_number} was "
                        "assigned an answer that also scored a plausible match here — "
                        "the student may have answered this whole multi-part question in "
                        "one block; review manually"
                    ]
                    review_status = ReviewStatus.NEEDS_REVIEW
                    break
        mappings.append(
            Mapping(
                question_id=question.question_id,
                answer_id=None,
                mapping_type=MappingType.UNANSWERED,
                confidence=0.0,
                review_status=review_status,
                regions=[],
                evidence=MappingEvidence(stage="unanswered", notes=notes),
            )
        )

    for column, answer in enumerate(answers):
        if column in matched_columns:
            continue
        mappings.append(_unmatched(answer))

    return MappingResult(mappings=mappings, used_llm=used_llm)


def _unmatched(answer: ExtractedAnswer) -> Mapping:
    """Extra answers are kept and surfaced, never discarded."""
    return Mapping(
        question_id=None,
        answer_id=answer.answer_id,
        mapping_type=MappingType.UNMATCHED,
        confidence=0.0,
        review_status=ReviewStatus.NEEDS_REVIEW,
        regions=list(answer.regions),
        evidence=MappingEvidence(stage="unmatched", notes=["answer assigned to no question"]),
    )


def _dominant_stage(label: float, spatial: float, semantic: float) -> str:
    if label >= stages.LABEL_EXACT:
        return "label"
    ranked = {"label": label, "spatial": spatial, "semantic": semantic}
    return max(ranked, key=lambda key: ranked[key])


def _mapping_type(evidence: MappingEvidence) -> MappingType:
    if evidence.label_score >= stages.LABEL_EXACT:
        return MappingType.DIRECT
    if evidence.semantic_score > evidence.spatial_score:
        return MappingType.SEMANTIC
    return MappingType.SPATIAL
