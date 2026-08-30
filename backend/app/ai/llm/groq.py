"""Groq adapter, built on LangChain's ChatGroq.

Same shape as the Gemini adapter (ADR-002: LangChain lives inside provider adapters,
never in the orchestration layer), with two Groq-specific differences:

* Text and vision run on different models. Groq's JSON-mode text models are text-only,
  so `transcribe` uses a separate multimodal model (`GROQ_VISION_MODEL`). Leaving that
  setting empty disables vision, and handwriting validation falls back to raw OCR text.
* Images go in the OpenAI content-block shape (`image_url` as a dict), not Gemini's
  flat string, and Groq rejects an image request over 20MB.

Model ids on Groq are deprecated and replaced often. Verify the configured ids against
`GET https://api.groq.com/openai/v1/models` rather than trusting the defaults here.
"""
from __future__ import annotations

import base64
import json
from typing import Any

from app.ai.llm import breaker
from app.ai.llm.base import DocumentVisionProvider, LLMProvider
from app.ai.llm.parsing import content_text, parse_json
from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


class GroqProvider(LLMProvider, DocumentVisionProvider):
    name = "groq"

    def __init__(
        self,
        model: str | None = None,
        vision_model: str | None = None,
        api_key: str | None = None,
    ) -> None:
        super().__init__()
        self._model_name = model or settings.groq_model
        self._vision_model_name = vision_model if vision_model is not None else settings.groq_vision_model
        self._api_key = api_key or settings.groq_api_key
        self._clients: dict[str, Any] = {}

    def _lazy(self, model_name: str, json_mode: bool) -> Any | None:
        if model_name in self._clients:
            return self._clients[model_name]
        if not self._api_key or not model_name:
            return None
        try:
            from langchain_groq import ChatGroq  # type: ignore[import-not-found]
        except ImportError:  # pragma: no cover - environment dependent
            log.warning("langchain_groq not installed; falling back")
            return None
        kwargs: dict[str, Any] = {}
        if json_mode and settings.groq_json_mode:
            # Groq honours OpenAI's JSON mode; the prompt already says "JSON", which the
            # API requires. A model that rejects it raises, and the caller falls back.
            kwargs["model_kwargs"] = {"response_format": {"type": "json_object"}}
        if settings.groq_base_url:
            kwargs["base_url"] = settings.groq_base_url
        client = ChatGroq(
            model=model_name,
            api_key=self._api_key,
            temperature=0,
            max_retries=max(1, settings.llm_max_attempts),
            **kwargs,
        )
        self._clients[model_name] = client
        return client

    def _invoke(self, content: Any, model_name: str, json_mode: bool) -> dict[str, Any] | None:
        if breaker.is_open(self.name):
            self.usage.detail.append("skipped: quota cooldown")
            return None
        client = self._lazy(model_name, json_mode)
        if client is None:
            return None
        try:  # pragma: no cover - requires network
            from langchain_core.messages import HumanMessage

            response = client.invoke([HumanMessage(content=content)])
            self.usage.calls += 1
            meta = getattr(response, "usage_metadata", None) or {}
            self.usage.prompt_tokens += int(meta.get("input_tokens", 0))
            self.usage.completion_tokens += int(meta.get("output_tokens", 0))
            return parse_json(content_text(response.content))
        except Exception as exc:  # noqa: BLE001 - any provider failure degrades to fallback
            if breaker.is_quota_error(exc):
                breaker.trip(self.name, model_name)
            else:
                log.warning("groq call failed", extra={"error": str(exc), "model": model_name})
            return None

    def complete_json(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        instruction = f"{prompt}\n\nReturn ONLY JSON matching this schema:\n{json.dumps(schema)}"
        return self._invoke(instruction, self._model_name, json_mode=True)

    def structure_blocks(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        return self.complete_json(prompt, schema)

    def transcribe(self, image_bytes: bytes, ocr_text: str) -> str | None:
        if not self._vision_model_name:
            return None
        encoded = base64.b64encode(image_bytes).decode()
        if len(encoded) > settings.groq_max_image_bytes:
            log.warning("crop too large for groq vision", extra={"bytes": len(encoded)})
            return None
        payload = [
            {
                "type": "text",
                "text": (
                    "Transcribe the handwriting in this image. OCR read it as:\n"
                    f"{ocr_text}\n\nReturn ONLY JSON: {{\"text\": \"...\"}}. "
                    "Do not describe the image and do not return coordinates."
                ),
            },
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
        ]
        result = self._invoke(payload, self._vision_model_name, json_mode=True)
        if not result:
            return None
        text = result.get("text")
        return text if isinstance(text, str) and text.strip() else None

    def transcribe_page(
        self,
        image_bytes: bytes,
        ocr_lines: list[str],
        confidences: list[float] | None = None,
    ) -> list[str] | None:
        """Correct all OCR lines on a full page in one vision call.

        Sends the full page image + all OCR lines as numbered context. Lines with low
        OCR confidence are annotated so the model prioritises them. One call per page
        instead of one per answer segment — fewer API calls, more visual context.
        """
        if not self._vision_model_name:
            return None
        encoded = base64.b64encode(image_bytes).decode()
        if len(encoded) > settings.groq_max_image_bytes:
            log.warning("page image too large for groq vision", extra={"bytes": len(encoded)})
            return None
        numbered = _format_lines_with_confidence(ocr_lines, confidences)
        payload = [
            {
                "type": "text",
                "text": (
                    "This is a scanned handwritten exam answer sheet. "
                    "The OCR below misread the handwriting. "
                    "Look at the image and correct each numbered OCR line. "
                    "Lines marked [LOW] have low OCR confidence — pay extra attention to them. "
                    "Preserve question labels (e.g. '1.', '(a)', 'Q2') exactly as written. "
                    "Preserve domain terms (biology, chemistry, etc.) exactly as written. "
                    f"There are exactly {len(ocr_lines)} lines numbered 0 to {len(ocr_lines)-1}. "
                    f"Return ONLY a JSON object: {{\"lines\": [\"corrected line 0\", \"corrected line 1\", ...]}} "
                    f"with exactly {len(ocr_lines)} strings in the array.\n\n"
                    f"OCR lines to correct:\n{numbered}"
                ),
            },
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
        ]
        result = self._invoke(payload, self._vision_model_name, json_mode=False)
        if not result:
            return None
        lines = result.get("lines")
        if not isinstance(lines, list) or len(lines) == 0:
            return None
        if len(lines) < len(ocr_lines):
            lines = lines + ocr_lines[len(lines):]
        return [str(line) for line in lines[:len(ocr_lines)]]


def _format_lines_with_confidence(
    lines: list[str], confidences: list[float] | None, threshold: float = 0.75
) -> str:
    """Format numbered OCR lines, annotating low-confidence ones with [LOW]."""
    parts = []
    for i, line in enumerate(lines):
        conf = confidences[i] if confidences and i < len(confidences) else 1.0
        tag = " [LOW]" if conf < threshold else ""
        parts.append(f"{i}{tag}: {line}")
    return "\n".join(parts)
