"""Response-body helpers shared by the chat-model adapters.

Every provider is asked for JSON and answers with prose-wrapped, fence-wrapped or
block-structured text, so the same two salvage steps apply to all of them.
"""
from __future__ import annotations

import json
from typing import Any


def content_text(content: Any) -> str:
    """Flatten a chat response body to plain text.

    Current LangChain builds return a list of typed content blocks rather than a string,
    and `str()` on that list yields a Python repr whose braces and quotes look enough
    like JSON to fool a naive scan — the parse then fails, or worse, half-succeeds.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return str(content)


def parse_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text.split("\n", 1)[-1] if not text.lstrip().startswith("{") else text
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
