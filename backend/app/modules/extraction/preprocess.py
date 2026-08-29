"""Image preprocessing for the OCR path.

Each step records its transform into a TransformChain so the pipeline can invert the
composition before storing any coordinate. Steps that do not move pixels (grayscale,
denoise, contrast) record the identity — they still appear in `chain.steps` so the
provenance of an image is visible in logs.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image, ImageFilter, ImageOps

from app.modules.extraction.ir import Transform, TransformChain

MIN_DESKEW_DEGREES = 0.2
MAX_DESKEW_DEGREES = 15.0


@dataclass
class PreprocessResult:
    image_bytes: bytes
    chain: TransformChain
    width: int
    height: int


def preprocess_for_ocr(
    image_bytes: bytes,
    target_long_edge: int | None = 2000,
    deskew: bool = True,
) -> PreprocessResult:
    image = Image.open(io.BytesIO(image_bytes)).convert("L")
    chain = TransformChain()
    chain.record("grayscale", Transform.identity())

    if deskew:
        angle = estimate_skew(image)
        if abs(angle) >= MIN_DESKEW_DEGREES:
            cx, cy = image.width / 2, image.height / 2
            # PIL's rotate(theta) maps points by our clockwise-positive rotation(-theta),
            # so correcting a +angle tilt means rotate(-angle) and recording rotation(+angle).
            image = image.rotate(-angle, resample=Image.Resampling.BICUBIC, fillcolor=255)
            chain.record("deskew", Transform.rotation(angle, cx, cy))

    image = image.filter(ImageFilter.MedianFilter(size=3))
    chain.record("denoise", Transform.identity())

    image = ImageOps.autocontrast(image, cutoff=1)
    chain.record("contrast", Transform.identity())

    if target_long_edge:
        long_edge = max(image.width, image.height)
        if long_edge > 0 and long_edge != target_long_edge:
            scale = target_long_edge / long_edge
            new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
            image = image.resize(new_size, Image.Resampling.LANCZOS)
            chain.record("resize", Transform.scaling(scale, scale))

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return PreprocessResult(buffer.getvalue(), chain, image.width, image.height)


def estimate_skew(image: Image.Image) -> float:
    """Cheap projection-profile skew estimate, in degrees (clockwise-positive).

    Deliberately coarse and dependency-free: a wrong small angle costs little, while
    pulling in OpenCV for this would make the container heavier for no accuracy gain.
    """
    small = image.resize((min(300, image.width), min(400, image.height)))
    pixels = list(small.getdata())
    width, height = small.size
    best_angle, best_score = 0.0, -1.0
    for angle in [float(x) for x in range(-int(MAX_DESKEW_DEGREES), int(MAX_DESKEW_DEGREES) + 1)]:
        score = _projection_score(pixels, width, height, angle)
        if score > best_score:
            best_angle, best_score = angle, score
    return best_angle


def _projection_score(pixels: list[int], width: int, height: int, angle: float) -> float:
    """Variance of the ink profile after shearing rows vertically by `angle`.

    Shearing must displace pixels in y as a function of x: a horizontal shift leaves
    every row's ink total unchanged and would score every angle identically.
    """
    shear = math.tan(math.radians(angle))
    rows = [0.0] * height
    for y in range(0, height, 2):
        base = y * width
        for x in range(0, width, 2):
            target = y + int(shear * (x - width / 2))
            if 0 <= target < height:
                rows[target] += 255 - pixels[base + x]
    mean = sum(rows) / len(rows)
    return sum((value - mean) ** 2 for value in rows) / len(rows)
