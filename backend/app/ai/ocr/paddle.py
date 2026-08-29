"""PaddleOCR adapter. The SDK is imported lazily so the package stays importable
(and the whole test suite runnable) on machines without it installed."""
from __future__ import annotations

import io
from typing import Any

from app.ai.ocr.base import OCREngine, OCRWord
from app.core.errors import ProviderUnavailableError


class PaddleOCREngine(OCREngine):
    name = "paddle"

    def __init__(self, lang: str = "en") -> None:
        self._lang = lang
        self._engine: Any | None = None

    def _lazy(self) -> Any:
        if self._engine is None:
            try:
                from paddleocr import PaddleOCR  # type: ignore[import-not-found]
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise ProviderUnavailableError("PaddleOCR is not installed.") from exc
            self._engine = PaddleOCR(use_angle_cls=True, lang=self._lang, show_log=False)
        return self._engine

    def run(self, image_bytes: bytes) -> list[OCRWord]:  # pragma: no cover - needs the SDK
        import numpy as np
        from PIL import Image

        engine = self._lazy()
        image = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
        raw = engine.ocr(image, cls=True) or []
        words: list[OCRWord] = []
        for page in raw:
            for entry in page or []:
                polygon, (text, confidence) = entry[0], entry[1]
                xs = [float(p[0]) for p in polygon]
                ys = [float(p[1]) for p in polygon]
                if not text.strip():
                    continue
                words.append(
                    OCRWord(
                        text=text,
                        x1=min(xs), y1=min(ys), x2=max(xs), y2=max(ys),
                        confidence=float(confidence),
                    )
                )
        return words
