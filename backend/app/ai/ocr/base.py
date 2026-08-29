"""OCR interface. Coordinates returned here are in PREPROCESSED image pixel space;
the extraction pipeline inverts the preprocessing transform before storing anything.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class OCRWord:
    text: str
    # pixel box in the image handed to the engine
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float


class OCREngine(ABC):
    name = "abstract"

    @abstractmethod
    def run(self, image_bytes: bytes) -> list[OCRWord]:
        """Recognise text in a PNG/JPEG image and return line-level boxes."""
