"""Each mapping stage in isolation, plus the global assignment and outcome states."""
from __future__ import annotations

from dataclasses import replace

from app.modules.mapping_engine import assignment, stages
from app.modules.mapping_engine.engine import MappingConfig, map_answers
from app.schemas.common import MappingType, Region, ReviewStatus
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion


def question(number: str, text: str, order: int = 0, optional: bool = False) -> ExtractedQuestion:
    return ExtractedQuestion(
        question_id=f"q-{number}",
        display_number=number,
        normalized_number=number,
        text=text,
        pages=[1],
        regions=[Region(page=1, bbox=[0.1, 0.1, 0.9, 0.2])],
        order_index=order,
        optional=optional,
        confidence=1.0,
    )


def answer(
    identifier: str, text: str, label: str | None = None, page: int = 1, y: float = 0.1
) -> ExtractedAnswer:
    return ExtractedAnswer(
        answer_id=identifier,
        raw_text=text,
        normalized_text=text,
        detected_label=label,
        page_numbers=[page],
        regions=[Region(page=page, bbox=[0.1, y, 0.9, y + 0.05])],
        confidence=0.9,
    )


# ------------------------------------------------------------------------- stage 1
def test_stage_1_exact_label_is_decisive():
    q = question("11.a", "Define refractive index")
    assert stages.label_score(q, answer("a1", "text", label="11.a")) == 1.0
    assert stages.label_score(q, answer("a2", "text", label="11.b")) == 0.0
    assert stages.label_score(q, answer("a3", "text", label="11")) == stages.LABEL_PARENT


# ------------------------------------------------------------------------- stage 2
def test_stage_2_spatial_prior_rewards_monotonic_order():
    questions = [question("1", "one", 0), question("2", "two", 1), question("3", "three", 2)]
    answers = [
        answer("a1", "first", y=0.1),
        answer("a2", "second", y=0.4),
        answer("a3", "third", y=0.7),
    ]
    q_rank = stages.build_ranks(stages.question_order(questions))
    a_rank = stages.build_ranks(stages.answer_order(answers))
    aligned = stages.spatial_score(questions[0], answers[0], q_rank, a_rank)
    crossed = stages.spatial_score(questions[0], answers[2], q_rank, a_rank)
    assert aligned > crossed


# ------------------------------------------------------------------------- stage 4
def test_stage_4_semantic_prefers_the_topical_answer():
    q = question("1", "Define velocity and state its SI unit")
    on_topic = answer("a1", "velocity is displacement per unit time in metres per second")
    off_topic = answer("a2", "photosynthesis converts light into chemical energy")
    assert stages.semantic_stage_score(q, on_topic) > stages.semantic_stage_score(q, off_topic)


# ------------------------------------------------------------------------- stage 6
def test_global_assignment_beats_greedy_stealing():
    """A strong local match must not steal an answer another question needed."""
    matrix = [
        [0.90, 0.85],   # q1 slightly prefers a1
        [0.88, 0.10],   # q2 can ONLY use a1
    ]
    pairs = dict(assignment.solve(matrix, reject_below=0.2))
    assert pairs == {0: 1, 1: 0}


def test_assignment_rejects_pairs_below_the_floor():
    assert assignment.solve([[0.1, 0.2]], reject_below=0.5) == []


# ------------------------------------------------------------------------- stage 7
def test_labelled_sheet_maps_directly_and_is_auto_accepted():
    questions = [question("1", "Define velocity", 0), question("2", "State Newton's law", 1)]
    answers = [
        answer("a1", "force equals mass times acceleration", label="2", y=0.1),
        answer("a2", "velocity is displacement over time", label="1", y=0.5),
    ]
    result = map_answers(questions, answers)
    by_question = {m.question_id: m for m in result.mappings}
    assert by_question["q-1"].answer_id == "a2"
    assert by_question["q-2"].answer_id == "a1"
    assert all(m.mapping_type == MappingType.DIRECT for m in by_question.values())
    assert all(m.review_status == ReviewStatus.AUTO_ACCEPTED for m in by_question.values())


def test_unanswered_and_unmatched_are_outcomes_not_errors():
    questions = [question("1", "Define velocity", 0), question("2", "State the law", 1)]
    answers = [answer("a1", "velocity is displacement over time", label="1")]
    result = map_answers(questions, answers)
    kinds = {m.question_id: m.mapping_type for m in result.mappings}
    assert kinds["q-2"] == MappingType.UNANSWERED

    extra = answer("a9", "a stray note about nothing in particular", page=2, y=0.9)
    result = map_answers([questions[0]], [answers[0], extra])
    unmatched = [m for m in result.mappings if m.mapping_type == MappingType.UNMATCHED]
    assert len(unmatched) == 1
    assert unmatched[0].answer_id == "a9"
    assert unmatched[0].regions  # the extra answer keeps its highlight regions


def test_optional_unanswered_question_is_not_flagged_for_review():
    questions = [question("12", "Attempt any one", 0, optional=True)]
    result = map_answers(questions, [])
    assert result.mappings[0].review_status == ReviewStatus.AUTO_ACCEPTED


def test_weak_matches_are_never_auto_accepted():
    questions = [question("1", "Define the coefficient of thermal expansion", 0)]
    answers = [answer("a1", "some unrelated scribble about a bicycle", y=0.5)]
    result = map_answers(questions, answers)
    matched = [m for m in result.mappings if m.answer_id and m.question_id]
    for mapping in matched:
        assert mapping.confidence < MappingConfig().accept_threshold
        assert mapping.review_status == ReviewStatus.NEEDS_REVIEW


def test_evidence_records_the_score_breakdown_for_review():
    questions = [question("1", "Define velocity", 0)]
    answers = [answer("a1", "velocity is displacement over time", label="1")]
    mapping = map_answers(questions, answers).mappings[0]
    assert mapping.evidence.label_score == 1.0
    assert mapping.evidence.combined_score > 0.9
    assert mapping.evidence.stage == "label"


def test_stages_can_be_disabled_independently():
    questions = [question("1", "Define velocity", 0)]
    answers = [answer("a1", "velocity is displacement over time", label="1")]
    without_labels = map_answers(questions, answers, replace(MappingConfig(), use_labels=False))
    assert without_labels.mappings[0].mapping_type != MappingType.DIRECT


def test_multi_page_answer_competes_as_one_candidate():
    questions = [question("5", "Describe the motion graph", 0)]
    first = answer("a1", "the graph is a straight line", label="5", page=1, y=0.8)
    second = ExtractedAnswer(
        answer_id="a2",
        raw_text="continuing on the next page",
        normalized_text="continuing on the next page",
        page_numbers=[2],
        regions=[Region(page=2, bbox=[0.1, 0.05, 0.9, 0.2])],
        confidence=0.9,
        is_continuation_of="a1",
    )
    result = map_answers(questions, [first, second])
    assert len(result.mappings) == 1
    assert result.mappings[0].answer_id == "a1"
    assert [region.page for region in result.mappings[0].regions] == [1, 2]


def test_llm_is_not_called_when_the_top_match_is_decisive():
    class ExplodingProvider:
        name = "boom"

        def complete_json(self, prompt, schema):  # pragma: no cover - must never run
            raise AssertionError("the LLM must not be called on a decisive match")

    questions = [question("1", "Define velocity", 0)]
    answers = [answer("a1", "velocity is displacement over time", label="1")]
    map_answers(questions, answers, MappingConfig(), llm=ExplodingProvider())
