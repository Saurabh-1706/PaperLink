"""OCR engine selection is config (ADR-004)."""
from __future__ import annotations

from app.ai.ocr.base import OCREngine
from app.core.config import settings

_override: OCREngine | None = None


def set_engine(engine: OCREngine | None) -> None:
    """Tests and the eval harness inject a deterministic engine through this."""
    global _override
    _override = engine


def get_ocr_engine() -> OCREngine:
    if _override is not None:
        return _override
    if settings.ocr_engine == "paddle":
        from app.ai.ocr.paddle import PaddleOCREngine

        return PaddleOCREngine()
    if settings.ocr_engine == "stub":
        from app.ai.ocr.stub import StubOCREngine

        return StubOCREngine()
    raise NotImplementedError(f"OCR engine '{settings.ocr_engine}' is not built yet")
