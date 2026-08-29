"""question_graph — deterministic extraction, then ambiguity routing.

The LLM node runs only when the deterministic checks fail, and it receives block ids
and returns block ids (ADR-001).
"""
from __future__ import annotations

from langgraph.graph import END, StateGraph

from app.ai.prompts.questions import QUESTION_STRUCTURE_SCHEMA, build_question_structure_prompt
from app.core.logging import get_logger
from app.graphs.state import QuestionGraphState
from app.modules.question_pipeline.pipeline import extract_questions
from app.schemas.common import Region, union_all
from app.schemas.ir import IRDocument
from app.schemas.pipeline import ExtractedQuestion, QuestionPipelineResult

log = get_logger(__name__)

MAX_BLOCKS_IN_PROMPT = 120


def _extract(state: QuestionGraphState) -> QuestionGraphState:
    result = extract_questions(state["ir"])
    return {"result": result, "ambiguities": result.ambiguities, "used_llm": False}


def _route(state: QuestionGraphState) -> str:
    if not state.get("ambiguities"):
        return "finalize"
    return "disambiguate" if state.get("provider") is not None else "finalize"


def _disambiguate(state: QuestionGraphState) -> QuestionGraphState:
    ir: IRDocument = state["ir"]
    result: QuestionPipelineResult = state["result"]
    provider = state["provider"]

    ordered = ir.ordered_blocks()[:MAX_BLOCKS_IN_PROMPT]
    prompt = build_question_structure_prompt(
        [(block.block_id, block.text) for _, block in ordered], state.get("ambiguities", [])
    )
    payload = provider.structure_blocks(prompt, QUESTION_STRUCTURE_SCHEMA)
    if not payload or not payload.get("questions"):
        # Deterministic result stands: no pipeline may require an LLM to produce output.
        return {"used_llm": True}

    repaired = _apply_structure(ir, payload["questions"], result)
    if repaired is None:
        return {"used_llm": True}
    return {"result": repaired, "used_llm": True}


def _apply_structure(
    ir: IRDocument, proposals: list[dict], previous: QuestionPipelineResult
) -> QuestionPipelineResult | None:
    index = {block.block_id: (page, block) for page, block in ir.ordered_blocks()}
    questions: list[ExtractedQuestion] = []
    for order, proposal in enumerate(proposals):
        block_ids = [bid for bid in proposal.get("block_ids", []) if bid in index]
        if not block_ids:
            continue
        by_page: dict[int, list] = {}
        texts: list[str] = []
        for block_id in block_ids:
            page, block = index[block_id]
            by_page.setdefault(page, []).append(block.bbox)
            texts.append(block.text)
        display = str(proposal.get("display_number", "")).strip()
        if not display:
            continue
        from app.modules.question_pipeline.labels import normalize_label, parent_of

        normalized = normalize_label(display, allow_answer_prefix=False) or display
        questions.append(
            ExtractedQuestion(
                question_id=f"q-{normalized}",
                display_number=display,
                normalized_number=normalized,
                parent_number=parent_of(normalized),
                text=" ".join(texts).strip(),
                pages=sorted(by_page),
                regions=[Region(page=page, bbox=union_all(boxes)) for page, boxes in sorted(by_page.items())],
                order_index=order,
                confidence=0.75,  # model-repaired structure is never treated as certain
                block_ids=block_ids,
            )
        )
    if not questions:
        return None
    return previous.model_copy(update={"questions": questions, "used_llm": True})


def _finalize(state: QuestionGraphState) -> QuestionGraphState:
    result: QuestionPipelineResult = state["result"]
    return {"result": result.model_copy(update={"used_llm": bool(state.get("used_llm"))})}


def build_question_graph():
    graph = StateGraph(QuestionGraphState)
    graph.add_node("extract", _extract)
    graph.add_node("disambiguate", _disambiguate)
    graph.add_node("finalize", _finalize)
    graph.set_entry_point("extract")
    graph.add_conditional_edges("extract", _route, {"disambiguate": "disambiguate", "finalize": "finalize"})
    graph.add_edge("disambiguate", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


def run_question_graph(ir: IRDocument, provider=None) -> QuestionPipelineResult:
    output = build_question_graph().invoke({"ir": ir, "provider": provider})
    return output["result"]
