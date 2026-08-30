"""Auto-crop / perspective-rectify: detection must fire on a real page and stay
silent on everything that only looks like one by accident."""
from __future__ import annotations

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from app.modules.documents.rectify import auto_rectify  # noqa: E402


def _encode(image: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".png", image)
    assert ok
    return buffer.tobytes()


def _skewed_page_photo() -> bytes:
    """A white page, perspective-warped onto a black background -- simulating a
    phone photo shot at an angle, the way a student actually takes one."""
    canvas = np.zeros((600, 800, 3), dtype=np.uint8)
    page = np.ones((400, 300, 3), dtype=np.uint8) * 255
    cv2.putText(page, "HELLO WORLD", (20, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)

    src = np.array([[0, 0], [299, 0], [299, 399], [0, 399]], dtype=np.float32)
    dst = np.array([[150, 80], [650, 40], [600, 520], [100, 560]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped_page = cv2.warpPerspective(page, matrix, (800, 600))
    mask = cv2.warpPerspective(
        np.ones((400, 300), dtype=np.uint8) * 255, matrix, (800, 600)
    )
    canvas[mask > 0] = warped_page[mask > 0]
    return _encode(canvas)


def test_skewed_page_is_detected_and_rectified():
    result = auto_rectify(_skewed_page_photo())
    assert result is not None
    assert result.width > 100 and result.height > 100


def test_flat_page_with_margin_is_detected():
    """A page that isn't skewed at all still has to be found -- rectification is a
    no-op geometrically, but the pipeline must not treat "no distortion" as
    "no page found"."""
    image = np.zeros((400, 600, 3), dtype=np.uint8)
    image[20:380, 30:570] = 255
    result = auto_rectify(_encode(image))
    assert result is not None


def test_random_noise_is_never_mistaken_for_a_page():
    """Dense, uncorrelated edge noise (heavy background clutter) can otherwise
    collapse into one blob covering the whole frame with high solidity -- exactly
    the shape a real page also has. Must be rejected, not silently 'rectified'
    into a no-op that hides a real detection failure."""
    rng = np.random.default_rng(0)
    for _ in range(5):
        noise = rng.integers(0, 256, size=(400, 600, 3), dtype=np.uint8)
        assert auto_rectify(_encode(noise)) is None


def test_invalid_image_bytes_return_none_not_an_exception():
    assert auto_rectify(b"not an image") is None
    assert auto_rectify(b"") is None
