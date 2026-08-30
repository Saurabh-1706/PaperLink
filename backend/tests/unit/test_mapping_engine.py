"""Each mapping stage in isolation, plus the global assignment and outcome states."""
from __future__ import annotations

from dataclasses import replace

from app.modules.mapping_engine import assignment, stages
from app.modules.mapping_engine.engine import MappingConfig, map_answers
from app.schemas.common import MappingType, Region, ReviewStatus
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion


def question(
    number: str, text: str, order: int = 0, optional: bool = False, parent: str | None = None
) -> ExtractedQuestion:
    return ExtractedQuestion(
        question_id=f"q-{number}",
        display_number=number,
        normalized_number=number,
        parent_number=parent,
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


# --------------------------------------------------------- out-of-order unlabelled fix
def test_unlabelled_out_of_order_match_is_not_diluted_below_the_review_floor():
    """A strong semantic match with zero positional evidence (an answer written out of
    the expected question order) must not be diluted below `review_threshold` just
    because spatial contributed nothing to the weighted average. Previously the
    renormalized blend capped a semantic-only match around 0.42-0.47, so even a
    near-perfect text match on a reordered answer was silently left unanswered."""
    combined = stages.combine(label=0.0, spatial=0.0, semantic=0.9)
    assert combined >= MappingConfig().review_threshold

    # A genuinely unrelated, unlabelled, out-of-order answer must still be rejected.
    assert stages.combine(label=0.0, spatial=0.0, semantic=0.0) == 0.0

    # Spatial alone (no semantic support) must still not be enough to force acceptance
    # on its own — guards against over-correcting the fix in the other direction.
    assert stages.combine(label=0.0, spatial=1.0, semantic=0.0) < MappingConfig().accept_threshold


def test_offset_detection_is_not_skewed_by_heavily_sub_divided_questions():
    """A question with several sub-parts must not get one offset vote per sub-part.
    With 4 sub-parts under Q1 and none under Q2, the old vote-per-row scan let Q1's
    sub-parts outvote the correct offset (0) with a wrong one (+1), even though every
    answer on the sheet was numbered consistently with the question paper."""
    questions = [
        question("1.a", "part a", order=0, parent="1"),
        question("1.b", "part b", order=1, parent="1"),
        question("1.c", "part c", order=2, parent="1"),
        question("1.d", "part d", order=3, parent="1"),
        question("2", "second question", order=4),
    ]
    answers = [answer("a1", "text", label="1"), answer("a2", "text", label="2")]
    assert stages.detect_label_offset(questions, answers) == 0


def test_answer_order_pushes_positionless_answers_to_the_end():
    """An answer with no page/region has no real position. Defaulting it to (0, 0.0)
    used to sort it ahead of every properly-positioned answer, shifting every rank
    after it and corrupting the spatial signal for the rest of the page."""
    positioned_first = answer("a1", "first", y=0.1)
    positioned_second = answer("a2", "second", y=0.4)
    positionless = ExtractedAnswer(
        answer_id="a3", raw_text="stray", normalized_text="stray", confidence=0.9
    )
    order = stages.answer_order([positioned_first, positionless, positioned_second])
    assert order == ["a1", "a2", "a3"]


# ------------------------------------------------------------- multi-part sibling sharing
def test_multi_part_sibling_losing_the_shared_answer_is_flagged_not_left_blank():
    """One answer labelled only with the parent number ("11") scores equally against
    every sub-part 11.a / 11.b, but one-to-one assignment can only award it to one of
    them. The sibling that loses the race is not truly blank — it should carry a note
    pointing the reviewer at the answer it may share, and be flagged for review."""
    q_a = question("11.a", "Define momentum", order=0, parent="11")
    q_b = question("11.b", "State the SI unit of momentum", order=1, parent="11")
    shared = answer("a1", "momentum is mass times velocity, measured in kg m per second", label="11")

    result = map_answers([q_a, q_b], [shared])
    by_question = {m.question_id: m for m in result.mappings}

    winners = [m for m in by_question.values() if m.answer_id == "a1"]
    losers = [m for m in by_question.values() if m.answer_id is None]
    assert len(winners) == 1
    assert len(losers) == 1

    loser = losers[0]
    assert loser.review_status == ReviewStatus.NEEDS_REVIEW
    assert loser.regions == []
    assert "shared answer" in loser.evidence.notes[0]
    winner_question = q_a if winners[0].question_id == q_a.question_id else q_b
    assert winner_question.display_number in loser.evidence.notes[0]
