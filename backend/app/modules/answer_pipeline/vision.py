"""Stage 4 — vision-LLM transcription validation, for low-confidence regions only.

The model improves what the text says, never where it is: coordinates are untouched by
this stage (ADR-001).
"""
from __future__ import annotations

import io

from app.ai.llm.base import DocumentVisionProvider
from app.core.logging import get_logger
from app.modules.answer_pipeline.pipeline import normalize_text
from app.modules.extraction.ir import denormalize_bbox
from app.schemas.common import Region
from app.schemas.pipeline import ExtractedAnswer

log = get_logger(__name__)

CONFIDENCE_AFTER_VALIDATION = 0.90


def crop_region(image_bytes: bytes, region: Region, padding: float = 0.01) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes))
    x1, y1, x2, y2 = denormalize_bbox(region.bbox, image.width, image.height)
    pad_x, pad_y = padding * image.width, padding * image.height
    box = (
        max(0, int(x1 - pad_x)),
        max(0, int(y1 - pad_y)),
        min(image.width, int(x2 + pad_x)),
        min(image.height, int(y2 + pad_y)),
    )
    buffer = io.BytesIO()
    image.crop(box).save(buffer, format="PNG")
    return buffer.getvalue()


def validate_transcriptions(
    answers: list[ExtractedAnswer],
    page_images: dict[int, bytes],
    provider: DocumentVisionProvider,
    answer_ids: list[str],
) -> tuple[list[ExtractedAnswer], bool]:
    """Re-read only the flagged answers. Returns (answers, used_llm)."""
    targets = set(answer_ids)
    if not targets:
        return answers, False

    used = False
    out: list[ExtractedAnswer] = []
    for answer in answers:
        if answer.answer_id not in targets or not answer.regions:
            out.append(answer)
            continue
        region = answer.regions[0]
        image = page_images.get(region.page)
        if image is None:
            out.append(answer)
            continue
        try:
            crop = crop_region(image, region)
            corrected = provider.transcribe(crop, answer.raw_text)
        except Exception as exc:  # noqa: BLE001 - provider failure must not fail the stage
            log.warning("vision validation failed", extra={"answer_id": answer.answer_id, "error": str(exc)})
            corrected = None
        if not corrected:
            out.append(answer)
            continue
        used = True
        out.append(
            answer.model_copy(
                update={
                    # raw_text stays as OCR produced it; the reviewer needs the original.
                    "normalized_text": normalize_text(corrected),
                    "confidence": max(answer.confidence, CONFIDENCE_AFTER_VALIDATION),
                }
            )
        )
    return out, used
