"""mapping_graph — deterministic solve first; the LLM band is entered only if the
deterministic pass left mappings under the accept threshold."""
from __future__ import annotations

from dataclasses import replace

from langgraph.graph import END, StateGraph

from app.core.logging import get_logger
from app.graphs.state import MappingGraphState
from app.modules.mapping_engine.engine import MappingConfig, map_answers
from app.schemas.common import MappingType, ReviewStatus
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion, MappingResult

log = get_logger(__name__)


def _deterministic(state: MappingGraphState) -> MappingGraphState:
    config: MappingConfig = state.get("config") or MappingConfig()
    result = map_answers(
        state["questions"], state["answers"], replace(config, use_llm=False), llm=None
    )
    undecided = any(
        mapping.review_status == ReviewStatus.NEEDS_REVIEW
        and mapping.mapping_type not in (MappingType.UNANSWERED,)
        for mapping in result.mappings
    )
    return {"result": result, "needs_llm": undecided, "used_llm": False}


def _route(state: MappingGraphState) -> str:
    if not state.get("needs_llm"):
        return "finalize"
    config: MappingConfig = state.get("config") or MappingConfig()
    return "validate" if (state.get("provider") is not None and config.use_llm) else "finalize"


def _validate(state: MappingGraphState) -> MappingGraphState:
    config: MappingConfig = state.get("config") or MappingConfig()
    result = map_answers(state["questions"], state["answers"], config, llm=state["provider"])
    return {"result": result, "used_llm": result.used_llm}


def _finalize(state: MappingGraphState) -> MappingGraphState:
    result: MappingResult = state["result"]
    return {"result": result.model_copy(update={"used_llm": bool(state.get("used_llm"))})}


def build_mapping_graph():
    graph = StateGraph(MappingGraphState)
    graph.add_node("deterministic", _deterministic)
    graph.add_node("validate", _validate)
    graph.add_node("finalize", _finalize)
    graph.set_entry_point("deterministic")
    graph.add_conditional_edges("deterministic", _route, {"validate": "validate", "finalize": "finalize"})
    graph.add_edge("validate", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


def run_mapping_graph(
    questions: list[ExtractedQuestion],
    answers: list[ExtractedAnswer],
    provider=None,
    config: MappingConfig | None = None,
) -> MappingResult:
    output = build_mapping_graph().invoke(
        {"questions": questions, "answers": answers, "provider": provider, "config": config}
    )
    return output["result"]
