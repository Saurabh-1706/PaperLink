"""RapidOCR (ONNXRuntime) adapter.

Same contract as every other engine: line-level boxes in PREPROCESSED image pixel
space, confidence in [0,1]. The SDK is imported lazily so the package stays importable
on machines without it (ADR-004).

RapidOCR is a print-trained recogniser. On handwriting its *detector* still finds the
lines reliably while the *recogniser* is weak, which is exactly the split the pipeline
is built around: geometry comes from OCR, and the low-confidence text is re-read by the
vision provider (`answer_pipeline/vision.py`). Coordinates are never revised by a model.
"""
from __future__ import annotations

import io
from typing import Any

from app.ai.ocr.base import OCREngine, OCRWord
from app.core.errors import ProviderUnavailableError


class RapidOCREngine(OCREngine):
    name = "rapid"

    def __init__(self, text_score: float = 0.2) -> None:
        # Deliberately permissive: a low-confidence handwriting line is flagged
        # downstream, never dropped here.
        self._text_score = text_score
        self._engine: Any | None = None

    def _lazy(self) -> Any:
        if self._engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise ProviderUnavailableError("RapidOCR is not installed.") from exc
            self._engine = RapidOCR(text_score=self._text_score)
        return self._engine

    def run(self, image_bytes: bytes) -> list[OCRWord]:  # pragma: no cover - needs the SDK
        import numpy as np
        from PIL import Image

        engine = self._lazy()
        image = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
        result, _elapsed = engine(image)
        words: list[OCRWord] = []
        for entry in result or []:
            polygon, text, confidence = entry[0], entry[1], entry[2]
            if not str(text).strip():
                continue
            xs = [float(point[0]) for point in polygon]
            ys = [float(point[1]) for point in polygon]
            words.append(
                OCRWord(
                    text=str(text),
                    x1=min(xs), y1=min(ys), x2=max(xs), y2=max(ys),
                    confidence=float(confidence),
                )
            )
        return words
