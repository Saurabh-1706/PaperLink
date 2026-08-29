"""Gemini adapter, built on LangChain's chat model + structured output.

LangChain is used here and only here: inside a provider adapter called from graph
nodes. It is never the orchestration layer (ADR-002).
"""
from __future__ import annotations

import base64
import json
from typing import Any

from app.ai.llm.base import DocumentVisionProvider, LLMProvider
from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


class GeminiProvider(LLMProvider, DocumentVisionProvider):
    name = "gemini"

    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        super().__init__()
        self._model_name = model or settings.llm_model
        self._api_key = api_key or settings.gemini_api_key
        self._client: Any | None = None

    def _lazy(self) -> Any | None:
        if self._client is None:
            if not self._api_key:
                return None
            try:
                from langchain_google_genai import (
                    ChatGoogleGenerativeAI,  # type: ignore[import-not-found]
                )
            except ImportError:  # pragma: no cover - environment dependent
                log.warning("langchain_google_genai not installed; falling back")
                return None
            self._client = ChatGoogleGenerativeAI(
                model=self._model_name, google_api_key=self._api_key, temperature=0
            )
        return self._client

    def _invoke(self, content: Any, schema: dict[str, Any]) -> dict[str, Any] | None:
        client = self._lazy()
        if client is None:
            return None
        try:  # pragma: no cover - requires network
            from langchain_core.messages import HumanMessage

            response = client.invoke([HumanMessage(content=content)])
            self.usage.calls += 1
            meta = getattr(response, "usage_metadata", None) or {}
            self.usage.prompt_tokens += int(meta.get("input_tokens", 0))
            self.usage.completion_tokens += int(meta.get("output_tokens", 0))
            return _parse_json(_content_text(response.content))
        except Exception as exc:  # noqa: BLE001 - any provider failure degrades to fallback
            log.warning("gemini call failed", extra={"error": str(exc)})
            return None

    def complete_json(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        instruction = f"{prompt}\n\nReturn ONLY JSON matching this schema:\n{json.dumps(schema)}"
        return self._invoke(instruction, schema)

    def structure_blocks(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        return self.complete_json(prompt, schema)

    def transcribe(self, image_bytes: bytes, ocr_text: str) -> str | None:
        payload = [
            {
                "type": "text",
                "text": (
                    "Transcribe the handwriting in this image. OCR read it as:\n"
                    f"{ocr_text}\n\nReturn ONLY JSON: {{\"text\": \"...\"}}. "
                    "Do not describe the image and do not return coordinates."
                ),
            },
            {
                "type": "image_url",
                "image_url": f"data:image/png;base64,{base64.b64encode(image_bytes).decode()}",
            },
        ]
        result = self._invoke(payload, {"type": "object", "properties": {"text": {"type": "string"}}})
        if not result:
            return None
        text = result.get("text")
        return text if isinstance(text, str) and text.strip() else None


def _content_text(content: Any) -> str:
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


def _parse_json(text: str) -> dict[str, Any] | None:
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
