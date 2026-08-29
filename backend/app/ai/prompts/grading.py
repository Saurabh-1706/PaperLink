"""Versioned prompt for rubric scoring of open-ended answers."""
from __future__ import annotations

PROMPT_VERSION = "rubric-scoring.v1"

GRADING_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "number"},
        "feedback": {"type": "string"},
        "breakdown": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "awarded": {"type": "number"},
                    "max_marks": {"type": "number"},
                    "rationale": {"type": "string"},
                },
                "required": ["name", "awarded", "max_marks"],
            },
        },
    },
    "required": ["score"],
}


def build_grading_prompt(
    question_text: str, answer_text: str, max_marks: float, criteria: list[tuple[str, float]]
) -> str:
    lines = [
        f"[{PROMPT_VERSION}]",
        "Score a student's exam answer against the rubric. Be strict and concise.",
        "",
        f"QUESTION: {question_text}",
        f"MAX MARKS: {max_marks}",
        "RUBRIC:",
    ]
    lines.extend(f"- {name} (weight {weight})" for name, weight in criteria)
    lines.extend(["", f"STUDENT ANSWER: {answer_text}", ""])
    lines.append(
        'Return JSON: {"score": <0..MAX>, "feedback": "<two sentences>", '
        '"breakdown": [{"name": "...", "awarded": 0, "max_marks": 0, "rationale": "..."}]}'
    )
    return "\n".join(lines)
