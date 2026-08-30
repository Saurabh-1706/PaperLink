"""Stage 4 — vision-LLM transcription correction, one call per page.

The model sees the full page image and all OCR lines at once, which gives it the
context needed to read handwriting correctly. Coordinates are never touched (ADR-001).

Improvements over the baseline:
- OCR artifact cleaning (0→O, rn→m, etc.) applied before the LLM sees the text.
- Domain term masking: biology/exam terms are replaced with placeholders before the
  LLM call and restored afterwards, preventing hallucinated "corrections".
- Per-line OCR confidence passed to the provider so it can annotate [LOW] lines.
- PNG→JPEG compression for page images that exceed the provider's size limit.
"""
from __future__ import annotations

import hashlib
import io

from app.ai.llm.base import DocumentVisionProvider
from app.ai.ocr.correction import clean_artifacts, mask_domain_terms, restore_domain_terms
from app.core.config import settings
from app.core.logging import get_logger
from app.modules.answer_pipeline.pipeline import normalize_text
from app.modules.extraction.ir import denormalize_bbox
from app.schemas.common import Region
from app.schemas.pipeline import ExtractedAnswer

log = get_logger(__name__)

CONFIDENCE_AFTER_VALIDATION = 0.90
_JPEG_QUALITY = 75  # good balance of size vs. readability for vision models

# Process-local memo for `_compress_for_vision`. A page image does not change within a
# run, but every flagged answer group on that page asks for the same JPEG, so the
# decode/re-encode was being repeated for identical bytes. Keyed by (sha256(input),
# limit); bounded and evicted oldest-first so a long-lived worker cannot grow it
# without limit.
_COMPRESS_CACHE_MAX = 8
_compress_cache: dict[tuple[str, int], bytes] = {}
_compress_encodes = 0  # number of genuine JPEG encodes performed; read by tests


def clear_compress_cache() -> None:
    """Drop the memo (tests, and any caller that wants the memory back)."""
    global _compress_encodes
    _compress_cache.clear()
    _compress_encodes = 0


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


def _compress_for_vision(image_bytes: bytes, limit: int) -> bytes:
    """Return JPEG-compressed bytes if the PNG exceeds `limit` encoded bytes."""
    global _compress_encodes
    import base64

    if len(base64.b64encode(image_bytes)) <= limit:
        return image_bytes

    key = (hashlib.sha256(image_bytes).hexdigest(), limit)
    cached = _compress_cache.get(key)
    if cached is not None:
        return cached

    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    compressed = buf.getvalue()
    _compress_encodes += 1
    if len(base64.b64encode(compressed)) <= limit:
        log.debug("compressed page image to JPEG for vision", extra={"original_kb": len(image_bytes) // 1024, "compressed_kb": len(compressed) // 1024})
        result = compressed
    else:
        # Still too large — caller will skip vision for this page.
        result = image_bytes

    # Memoise both outcomes: re-deriving the "still too large" verdict costs the same
    # decode and re-encode as the successful path.
    if len(_compress_cache) >= _COMPRESS_CACHE_MAX:
        _compress_cache.pop(next(iter(_compress_cache)))
    _compress_cache[key] = result
    return result


def validate_transcriptions(
    answers: list[ExtractedAnswer],
    page_images: dict[int, bytes],
    provider: DocumentVisionProvider,
    answer_ids: list[str],
) -> tuple[list[ExtractedAnswer], bool]:
    """Re-read low-confidence answers using one vision call per page.

    Groups flagged answers by page, sends the full page image + all OCR block texts
    to the vision model in a single call, then maps corrected lines back to answers.
    Falls back to the old per-crop path if transcribe_page is not supported.
    """
    targets = set(answer_ids)
    if not targets:
        return answers, False

    by_page: dict[int, list[int]] = {}
    for idx, answer in enumerate(answers):
        if answer.answer_id in targets and answer.regions:
            page = answer.regions[0].page
            by_page.setdefault(page, []).append(idx)

    used = False
    corrected_text: dict[str, str] = {}

    for page, indices in by_page.items():
        image = page_images.get(page)
        if image is None:
            continue

        # Compress if needed before any vision call.
        image = _compress_for_vision(image, settings.groq_max_image_bytes)

        page_answers = [answers[i] for i in indices]

        # Pre-clean OCR artifacts and collect per-line confidences.
        cleaned_lines = [clean_artifacts(a.raw_text) for a in page_answers]
        confidences = [a.confidence for a in page_answers]

        # Mask domain terms so the LLM cannot "correct" them.
        masked_lines: list[str] = []
        restore_maps: list[dict[str, str]] = []
        for line in cleaned_lines:
            masked, restore_map = mask_domain_terms(line)
            masked_lines.append(masked)
            restore_maps.append(restore_map)

        # Try page-level correction first (one call, full context).
        try:
            result = provider.transcribe_page(image, masked_lines, confidences)
        except Exception as exc:  # noqa: BLE001
            log.warning("transcribe_page failed", extra={"page": page, "error": str(exc)})
            result = None

        if result is not None:
            used = True
            for answer, corrected, restore_map in zip(page_answers, result, restore_maps):
                if corrected and corrected.strip():
                    restored = restore_domain_terms(corrected, restore_map)
                    corrected_text[answer.answer_id] = normalize_text(restored)
        else:
            # Fall back: per-crop transcribe for each answer on this page.
            for answer, cleaned, restore_map in zip(page_answers, cleaned_lines, restore_maps):
                if not answer.regions:
                    continue
                try:
                    crop = crop_region(image, answer.regions[0])
                    masked_crop_text, _ = mask_domain_terms(cleaned)
                    corrected = provider.transcribe(crop, masked_crop_text)
                except Exception as exc:  # noqa: BLE001
                    log.warning("transcribe failed", extra={"answer_id": answer.answer_id, "error": str(exc)})
                    corrected = None
                if corrected and corrected.strip():
                    used = True
                    restored = restore_domain_terms(corrected, restore_map)
                    corrected_text[answer.answer_id] = normalize_text(restored)

    out: list[ExtractedAnswer] = []
    for answer in answers:
        new_text = corrected_text.get(answer.answer_id)
        if new_text is None:
            out.append(answer)
        else:
            out.append(answer.model_copy(update={
                "normalized_text": new_text,
                "confidence": max(answer.confidence, CONFIDENCE_AFTER_VALIDATION),
            }))
    return out, used
