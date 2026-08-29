"""answer_graph — segmentation, then vision validation for low-confidence regions only."""
from __future__ import annotations

from langgraph.graph import END, StateGraph

from app.core.logging import get_logger
from app.graphs.state import AnswerGraphState
from app.modules.answer_pipeline.pipeline import extract_answers
from app.modules.answer_pipeline.vision import validate_transcriptions
from app.schemas.ir import IRDocument
from app.schemas.pipeline import AnswerPipelineResult

log = get_logger(__name__)


def _segment(state: AnswerGraphState) -> AnswerGraphState:
    result = extract_answers(state["ir"])
    return {
        "result": result,
        "low_confidence_ids": result.low_confidence_answer_ids,
        "used_llm": False,
    }


def _route(state: AnswerGraphState) -> str:
    if not state.get("low_confidence_ids"):
        return "finalize"
    if state.get("provider") is None or not state.get("page_images"):
        return "finalize"
    return "validate"


def _validate(state: AnswerGraphState) -> AnswerGraphState:
    result: AnswerPipelineResult = state["result"]
    answers, used = validate_transcriptions(
        result.answers,
        state.get("page_images", {}),
        state["provider"],
        state.get("low_confidence_ids", []),
    )
    return {"result": result.model_copy(update={"answers": answers}), "used_llm": used}


def _finalize(state: AnswerGraphState) -> AnswerGraphState:
    result: AnswerPipelineResult = state["result"]
    remaining = [
        answer.answer_id
        for answer in result.answers
        if answer.answer_id in set(state.get("low_confidence_ids", []))
        and answer.confidence < 0.9
    ]
    return {
        "result": result.model_copy(
            update={
                "used_llm": bool(state.get("used_llm")),
                "low_confidence_answer_ids": remaining,
            }
        )
    }


def build_answer_graph():
    graph = StateGraph(AnswerGraphState)
    graph.add_node("segment", _segment)
    graph.add_node("validate", _validate)
    graph.add_node("finalize", _finalize)
    graph.set_entry_point("segment")
    graph.add_conditional_edges("segment", _route, {"validate": "validate", "finalize": "finalize"})
    graph.add_edge("validate", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


def run_answer_graph(
    ir: IRDocument, provider=None, page_images: dict[int, bytes] | None = None
) -> AnswerPipelineResult:
    output = build_answer_graph().invoke(
        {"ir": ir, "provider": provider, "page_images": page_images or {}}
    )
    return output["result"]
