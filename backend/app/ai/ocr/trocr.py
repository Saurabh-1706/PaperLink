"""TrOCR line recogniser (docs/10-ocr-upgrade-plan.md, Phase 5).

Deployment reality
------------------
TrOCR is an encoder-decoder: recognition is an *autoregressive decode*, one token at a
time per line, not a single forward pass. On CPU that is roughly 0.4-1.2 s per line for
`trocr-base-handwritten`, so a four-page answer sheet pays tens of seconds — slower than
the vision-LLM path it is meant to relieve. Batching amortises the encoder but not the
decode loop. This adapter is therefore GPU-gated: it ships behind `LINE_RECOGNIZER`,
default off, and only inverts the latency trade on a GPU worker with batch 8-16.

`trocr-base-handwritten` is IAM-trained: English handwriting, Latin script only. It has
no Devanagari and no mixed-script capability. Non-Latin or mixed papers must stay on the
vision-LLM path; pointing this recogniser at them produces fluent English nonsense, not
an error.

The 8-bit quantisation shown in the model card (`BitsAndBytesConfig(load_in_8bit=True)`)
is a CUDA kernel with no CPU implementation — on a CPU worker it is an import error or a
silent fallback, not a saving. The CPU route is an ONNX INT8 export (Phase 6).

`transformers` and `torch` are imported lazily inside `_lazy()`, never at module import
time, so the package stays importable and the suite runnable without them.
"""
from __future__ import annotations

import io
from typing import Any

from app.ai.ocr.recognizer import LineRecognizer, RecognizedLine
from app.core.errors import ProviderUnavailableError


class TrOCRLineRecognizer(LineRecognizer):
    name = "trocr"

    def __init__(
        self,
        model_name: str,
        batch_size: int = 8,
        device: str = "cpu",
        max_new_tokens: int = 64,
    ) -> None:
        # Everything is an argument, not a settings read: the factory owns configuration
        # (ADR-004), and the adapter stays constructible in a test with no config loaded.
        self._model_name = model_name
        self._batch_size = max(1, int(batch_size))
        self._device = device
        self._max_new_tokens = max_new_tokens
        self._processor: Any | None = None
        self._model: Any | None = None

    def _lazy(self) -> tuple[Any, Any]:
        if self._processor is None or self._model is None:
            try:
                from transformers import (  # type: ignore[import-not-found]
                    TrOCRProcessor,
                    VisionEncoderDecoderModel,
                )
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise ProviderUnavailableError(
                    "TrOCR requires the 'transformers' package, which is not installed."
                ) from exc
            try:
                import torch  # type: ignore[import-not-found]  # noqa: F401
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise ProviderUnavailableError(
                    "TrOCR requires the 'torch' package, which is not installed."
                ) from exc

            processor = TrOCRProcessor.from_pretrained(self._model_name)
            model = VisionEncoderDecoderModel.from_pretrained(self._model_name)
            model.to(self._device)
            model.eval()
            self._processor, self._model = processor, model
        return self._processor, self._model

    def read(self, crops: list[bytes]) -> list[RecognizedLine]:  # pragma: no cover - needs torch
        if not crops:
            return []
        processor, model = self._lazy()
        lines: list[RecognizedLine] = []
        for start in range(0, len(crops), self._batch_size):
            batch = crops[start : start + self._batch_size]
            lines.extend(self._read_batch(processor, model, batch))
        return lines

    def _read_batch(
        self, processor: Any, model: Any, batch: list[bytes]
    ) -> list[RecognizedLine]:  # pragma: no cover - needs torch
        import torch
        from PIL import Image

        images = [Image.open(io.BytesIO(crop)).convert("RGB") for crop in batch]
        pixel_values = processor(images=images, return_tensors="pt").pixel_values.to(self._device)

        with torch.no_grad():
            # Confidence is mandatory, not a nicety. Every downstream stage —
            # low_confidence flags, answer segmentation, the vision trigger — is driven
            # by a float in [0,1]. generate() returns only token ids by default; without
            # output_scores TrOCR lines would enter the IR carrying a fabricated
            # confidence and bypass all three of those safety nets.
            out = model.generate(
                pixel_values,
                max_new_tokens=self._max_new_tokens,
                output_scores=True,
                return_dict_in_generate=True,
            )

        texts = processor.batch_decode(out.sequences, skip_special_tokens=True)
        confidences = self._sequence_confidences(model, out, processor)
        return [
            RecognizedLine(text=text.strip(), confidence=confidence)
            for text, confidence in zip(texts, confidences)
        ]

    def _sequence_confidences(
        self, model: Any, out: Any, processor: Any
    ) -> list[float]:  # pragma: no cover - needs torch
        """exp(mean token logprob) per sequence, with padding/EOS masked out."""
        import torch

        generated = out.sequences[:, 1:]  # drop the decoder start token
        compute = getattr(model, "compute_transition_scores", None)
        if compute is not None:
            scores = compute(out.sequences, out.scores, normalize_logits=True)
        else:
            stacked = torch.stack(out.scores, dim=1)
            logprobs = torch.log_softmax(stacked, dim=-1)
            scores = logprobs.gather(2, generated.unsqueeze(-1)).squeeze(-1)

        # Padded positions after EOS carry meaningless scores; leaving them in drags the
        # mean toward whatever the pad token happened to score and makes short lines look
        # systematically worse (or better) than long ones.
        tokenizer = getattr(processor, "tokenizer", processor)
        pad_id = getattr(tokenizer, "pad_token_id", None)
        eos_id = getattr(tokenizer, "eos_token_id", None)
        mask = torch.ones_like(scores, dtype=torch.bool)
        if pad_id is not None:
            mask &= generated[:, : scores.shape[1]] != pad_id
        if eos_id is not None:
            mask &= generated[:, : scores.shape[1]] != eos_id
        mask &= torch.isfinite(scores)

        counts = mask.sum(dim=1)
        totals = (scores * mask).sum(dim=1)
        means = torch.where(counts > 0, totals / counts.clamp(min=1), torch.full_like(totals, -1e9))
        values = torch.exp(means).tolist()
        return [clamp_unit(float(v)) for v in values]


def clamp_unit(value: float) -> float:
    """Confidence must be a float in [0,1]; floating point exp can overshoot slightly."""
    if value != value:  # NaN
        return 0.0
    return max(0.0, min(1.0, value))


def plausible_length(
    candidate: str, ocr_text: str, low: float = 0.4, high: float = 2.5
) -> bool:
    """Is the candidate's length a plausible rendering of the same crop as `ocr_text`?

    The detector and the recogniser looked at the same pixels, so their transcriptions
    should be of comparable length. A candidate three times longer is the decoder's
    language model inventing a sentence; a candidate a third as long is a truncated
    decode. Both are rejected on length alone, before any confidence is consulted.

    An empty OCR text carries no length signal, so the ratio is undefined: accept any
    non-empty candidate and reject an empty one (an empty candidate replaces nothing).
    """
    candidate = candidate.strip()
    ocr_text = ocr_text.strip()
    if not ocr_text:
        return bool(candidate)
    if not candidate:
        return False
    ratio = len(candidate) / len(ocr_text)
    return low <= ratio <= high


def should_replace(
    candidate: RecognizedLine,
    ocr_text: str,
    ocr_confidence: float,
    high_confidence_floor: float,
) -> bool:
    """Should the TrOCR candidate overwrite the detector's line?

    TrOCR's decoder is a language model. Shown a diagram, a tick mark or a smudge it does
    not return empty — it returns fluent, confident, invented English. Every rejection
    below exists to keep that output out of the IR:

    - OCR line already high confidence -> the detector read it fine; replacing a good
      line can only lose information, and this is the guard that stops a misrouted
      printed line from being paraphrased.
    - Candidate empty or whitespace -> a failed decode. Replacing real text with nothing
      would silently delete an answer and drop it out of segmentation entirely.
    - Length implausible -> hallucinated continuation or truncated decode; see
      `plausible_length`.
    - Candidate confidence below the OCR line's -> the replacement is less trustworthy
      than what it replaces, so the swap would lower the line's confidence while making
      it look authoritative. Preferring the higher score also keeps the flag downstream:
      whatever survives, `low_confidence` still fires on it.
    """
    if ocr_confidence >= high_confidence_floor:
        return False
    if not candidate.text.strip():
        return False
    if not plausible_length(candidate.text, ocr_text):
        return False
    return candidate.confidence >= ocr_confidence
