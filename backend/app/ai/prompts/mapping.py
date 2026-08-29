"""Versioned prompt for stage 5. Bounded, cheap, auditable — not "map these for me"."""
from __future__ import annotations

PROMPT_VERSION = "mapping-validation.v1"

MAPPING_VALIDATION_SCHEMA = {
    "type": "object",
    "properties": {
        "answer_id": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "required": ["answer_id"],
}


def build_mapping_validation_prompt(question_text: str, candidates: list[tuple[str, str]]) -> str:
    lines = [
        f"[{PROMPT_VERSION}]",
        "You are checking which candidate answer belongs to one exam question.",
        "Choose exactly one candidate, or null if none fits.",
        "",
        f"QUESTION: {question_text}",
        "",
        "CANDIDATES:",
    ]
    for answer_id, text in candidates:
        lines.append(f"- id={answer_id}: {text}")
    lines.append("")
    lines.append('Return JSON: {"answer_id": "<id or null>", "reason": "<one short sentence>"}')
    return "\n".join(lines)
