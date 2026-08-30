"""Phase 3: illumination flattening.

The point of these tests is not that the image looks nicer — it is that the step is
*coordinate-free*. A preprocessing step that moved pixels without recording a transform
would corrupt every bbox in the system silently, with correct text and high confidence.
"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from app.modules.extraction.preprocess import (
    adaptive_threshold,
    flatten_illumination,
    preprocess_for_ocr,
)


def _shadowed_page(width: int = 400, height: int = 300) -> Image.Image:
    """A light page carrying a strong left-to-right illumination gradient, with a few
    dark glyph-sized marks on it. This is the phone-photo case autocontrast cannot fix:
    the same ink value appears at 200 on one side of the page and 90 on the other."""
    import numpy as np

    gradient = np.linspace(255, 120, width, dtype=np.float32)
    page = np.tile(gradient, (height, 1))
    # Ink: same *relative* darkness everywhere (40% of local paper), so a correct
    # flattening recovers one consistent ink value across the whole page.
    for x in (40, 200, 350):
        page[100:130, x : x + 20] *= 0.4
    return Image.fromarray(page.astype("uint8"))


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_flatten_equalises_ink_across_an_illumination_gradient():
    import numpy as np

    source = _shadowed_page()
    before = np.asarray(source, dtype=np.float32)
    after = np.asarray(flatten_illumination(source), dtype=np.float32)

    # Sample the three ink patches. Before flattening their values track the paper
    # gradient; after, they agree with each other.
    def ink(arr):
        return [float(arr[110, x + 10]) for x in (40, 200, 350)]

    spread_before = max(ink(before)) - min(ink(before))
    spread_after = max(ink(after)) - min(ink(after))
    assert spread_after < spread_before / 2, (
        f"ink spread should collapse: {spread_before:.1f} -> {spread_after:.1f}"
    )


def test_flatten_brightens_the_paper_toward_white():
    import numpy as np

    source = _shadowed_page()
    after = np.asarray(flatten_illumination(source), dtype=np.float32)
    # Paper away from the ink row should land near white on the dark side of the page,
    # which is exactly what the OCR detector wants.
    assert float(after[20, 380]) > 240


def test_flatten_keeps_the_ink_dark():
    """The regression guard that matters.

    Every other assertion here also passes for a function that returns a blank white
    page -- and a blank page is exactly what an inverted morphological order produces
    (MinFilter-then-MaxFilter thickens the strokes, so the background estimate becomes
    the ink, src/bg == 1, and the whole page flattens to 255). That bug reaches OCR as
    "zero lines detected", not as an exception.
    """
    import numpy as np

    after = np.asarray(flatten_illumination(_shadowed_page()), dtype=np.float32)
    for x in (40, 200, 350):
        ink = float(after[110, x + 10])
        paper = float(after[20, x + 10])
        assert ink < 160, f"ink at x={x} was flattened away (value {ink:.1f})"
        assert paper - ink > 60, f"contrast collapsed at x={x}: paper {paper:.1f} vs ink {ink:.1f}"


def test_flatten_preserves_image_dimensions():
    source = _shadowed_page()
    result = flatten_illumination(source)
    assert result.size == source.size


def test_flatten_survives_a_fully_black_patch():
    """Divide-by-zero guard: a solid black region makes the background estimate 0."""
    black = Image.new("L", (60, 60), color=0)
    result = flatten_illumination(black)
    assert result.size == (60, 60)


def test_flatten_records_an_identity_transform_and_leaves_coordinates_alone():
    """The contract check. Flattening must not shift a single coordinate."""
    page = _png(_shadowed_page())

    plain = preprocess_for_ocr(page, target_long_edge=None, deskew=False, flatten_background=False)
    flat = preprocess_for_ocr(page, target_long_edge=None, deskew=False, flatten_background=True)

    assert (flat.width, flat.height) == (plain.width, plain.height)

    probe = (10.0, 20.0, 90.0, 60.0)
    assert flat.chain.to_original(probe) == pytest.approx(plain.chain.to_original(probe))
    # And the step is visible in the provenance rather than applied invisibly.
    assert "flatten" in flat.chain.steps
    assert "contrast" in plain.chain.steps


def test_threshold_is_off_unless_asked_for():
    """Binarisation erases faint pencil, so it must never ride along with flattening."""
    page = _png(_shadowed_page())
    result = preprocess_for_ocr(page, target_long_edge=None, deskew=False, flatten_background=True)
    assert "threshold" not in result.chain.steps


def test_threshold_binarises_and_stays_coordinate_free():
    import numpy as np

    page = _png(_shadowed_page())
    result = preprocess_for_ocr(
        page, target_long_edge=None, deskew=False, flatten_background=True, threshold=True
    )
    arr = np.asarray(Image.open(io.BytesIO(result.image_bytes)))
    assert set(np.unique(arr)).issubset({0, 255})
    assert "threshold" in result.chain.steps


def test_adaptive_threshold_keeps_dimensions():
    source = _shadowed_page()
    assert adaptive_threshold(source).size == source.size
