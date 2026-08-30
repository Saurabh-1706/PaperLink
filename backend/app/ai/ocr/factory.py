"""OCR engine selection is config (ADR-004)."""
from __future__ import annotations

from app.ai.ocr.base import OCREngine
from app.ai.ocr.recognizer import LineRecognizer
from app.core.config import settings

_override: OCREngine | None = None
_singleton: OCREngine | None = None  # cached so ONNX models load only once
_recognizer_override: LineRecognizer | None = None
_recognizer_singleton: LineRecognizer | None = None


def set_engine(engine: OCREngine | None) -> None:
    """Tests and the eval harness inject a deterministic engine through this."""
    global _override, _singleton
    _override = engine
    _singleton = None  # clear cache when tests inject a new engine


def get_ocr_engine() -> OCREngine:
    global _singleton
    if _override is not None:
        return _override
    if _singleton is not None:
        return _singleton
    if settings.ocr_engine == "paddle":
        from app.ai.ocr.paddle import PaddleOCREngine
        _singleton = PaddleOCREngine()
    elif settings.ocr_engine == "rapid":
        from app.ai.ocr.rapid import RapidOCREngine
        _singleton = RapidOCREngine()
    elif settings.ocr_engine == "stub":
        from app.ai.ocr.stub import StubOCREngine
        _singleton = StubOCREngine()
    else:
        raise NotImplementedError(f"OCR engine '{settings.ocr_engine}' is not built yet")
    return _singleton


def set_line_recognizer(recognizer: LineRecognizer | None) -> None:
    """Tests and the eval harness inject a deterministic recogniser through this."""
    global _recognizer_override, _recognizer_singleton
    _recognizer_override = recognizer
    _recognizer_singleton = None


def get_line_recognizer() -> LineRecognizer | None:
    """The handwriting recogniser, or None when the feature is off.

    None rather than a null object: the caller has to decide whether to re-read a line
    at all, and "no recogniser configured" must skip the crop-and-batch work entirely
    rather than paying for it and discarding the result.

    Selection is config exactly as `ocr_engine` is (ADR-004). TrOCR decodes
    autoregressively at roughly 0.4-1.2 s per line on CPU, which is why the default is
    "none": on a CPU worker it costs more latency than the per-page vision call it
    would displace.
    """
    global _recognizer_singleton
    if _recognizer_override is not None:
        return _recognizer_override
    if _recognizer_singleton is not None:
        return _recognizer_singleton
    if settings.line_recognizer == "none":
        return None
    if settings.line_recognizer == "trocr":
        from app.ai.ocr.trocr import TrOCRLineRecognizer

        _recognizer_singleton = TrOCRLineRecognizer(
            model_name=settings.trocr_model,
            batch_size=settings.trocr_batch_size,
            device=settings.trocr_device,
            max_new_tokens=settings.trocr_max_new_tokens,
        )
    elif settings.line_recognizer == "stub":
        from app.ai.ocr.recognizer import StubLineRecognizer

        _recognizer_singleton = StubLineRecognizer()
    else:
        raise NotImplementedError(
            f"Line recognizer '{settings.line_recognizer}' is not built yet"
        )
    return _recognizer_singleton
