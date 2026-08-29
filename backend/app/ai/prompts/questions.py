"""Versioned prompt for question-structure disambiguation.

The model receives block ids and returns block ids. It never returns coordinates
(ADR-001) — the pipeline resolves ids back to stored bboxes.
"""
from __future__ import annotations

PROMPT_VERSION = "question-structure.v1"

QUESTION_STRUCTURE_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "display_number": {"type": "string"},
                    "block_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["display_number", "block_ids"],
            },
        }
    },
    "required": ["questions"],
}


def build_question_structure_prompt(blocks: list[tuple[str, str]], issues: list[str]) -> str:
    lines = [
        f"[{PROMPT_VERSION}]",
        "The deterministic parser flagged these problems with an exam paper's numbering:",
        *(f"- {issue}" for issue in issues),
        "",
        "Blocks, in reading order (id: text):",
    ]
    for block_id, text in blocks:
        lines.append(f"{block_id}: {text[:300]}")
    lines.append("")
    lines.append(
        'Return JSON: {"questions": [{"display_number": "11(a)", "block_ids": ["..."]}]}. '
        "Use only ids listed above. Never return coordinates."
    )
    return "\n".join(lines)
