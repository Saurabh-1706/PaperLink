"""Line recogniser interface — the second, narrower OCR interface.

Why this is not an `OCREngine`
------------------------------
`OCREngine.run(image_bytes) -> list[OCRWord]` is *page in, boxes out*: it is the
system's sole source of geometry, and every coordinate in the IR traces back to it.
A line recogniser is a different shape entirely — *crop in, text out*. It is handed a
crop that the detector already localised, and it returns a string and a confidence.
It produces no geometry at all.

That absence is the point, not an oversight. ADR-001 says coordinates come from the
deterministic extraction layer and never from a model; a recogniser that has no way to
emit a number that could become a coordinate satisfies that rule structurally rather
than by convention. Folding it into `OCREngine` would give it a box-shaped return type
it has no business filling in, and would invite exactly the drift ADR-001 rejects.

Batching lives in the signature (`read(crops: list[bytes])`) rather than in caller
discipline: an autoregressive recogniser invoked one crop at a time is a latency bug,
and an interface that permits it will eventually be used that way.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class RecognizedLine:
    text: str
    # exp(mean token logprob), clamped to [0,1] — the same scale as OCRWord.confidence,
    # so downstream low-confidence flagging needs no special case for this source.
    confidence: float


class LineRecognizer(ABC):
    name = "abstract"

    @abstractmethod
    def read(self, crops: list[bytes]) -> list[RecognizedLine]:
        """Batched by contract — a one-at-a-time recogniser is a latency bug."""


class NullLineRecognizer(LineRecognizer):
    """Selected when line recognition is switched off (the default deployment).

    Returns no lines at all rather than echoing the crops back, so a caller that
    forgets to check the flag replaces nothing instead of replacing everything with
    empty strings.
    """

    name = "none"

    def read(self, crops: list[bytes]) -> list[RecognizedLine]:
        return []


class StubLineRecognizer(LineRecognizer):
    """Deterministic recogniser for tests, mirroring `StubOCREngine`.

    Canned outputs are registered per crop checksum, with a default for anything
    unregistered, so guard and routing logic can be exercised offline with no torch.
    """

    name = "stub"

    def __init__(self) -> None:
        self._by_checksum: dict[str, RecognizedLine] = {}
        self._default: RecognizedLine | None = None

    @staticmethod
    def checksum(crop: bytes) -> str:
        import hashlib

        return hashlib.sha256(crop).hexdigest()

    def register(self, crop: bytes, line: RecognizedLine) -> None:
        self._by_checksum[self.checksum(crop)] = line

    def set_default(self, line: RecognizedLine | None) -> None:
        self._default = line

    def read(self, crops: list[bytes]) -> list[RecognizedLine]:
        out: list[RecognizedLine] = []
        for crop in crops:
            line = self._by_checksum.get(self.checksum(crop), self._default)
            out.append(line if line is not None else RecognizedLine(text="", confidence=0.0))
        return out
