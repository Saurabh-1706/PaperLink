"""Deterministic OCR engine used by tests and by environments without a real engine.

It returns whatever lines were registered for an image checksum, so extraction,
coordinate inversion and both pipelines can be exercised end to end offline.
"""
from __future__ import annotations

import hashlib

from app.ai.ocr.base import OCREngine, OCRWord


class StubOCREngine(OCREngine):
    name = "stub"

    def __init__(self) -> None:
        self._by_checksum: dict[str, list[OCRWord]] = {}
        self._default: list[OCRWord] = []

    @staticmethod
    def checksum(image_bytes: bytes) -> str:
        return hashlib.sha256(image_bytes).hexdigest()

    def register(self, image_bytes: bytes, words: list[OCRWord]) -> None:
        self._by_checksum[self.checksum(image_bytes)] = words

    def set_default(self, words: list[OCRWord]) -> None:
        self._default = words

    def run(self, image_bytes: bytes) -> list[OCRWord]:
        return self._by_checksum.get(self.checksum(image_bytes), self._default)
