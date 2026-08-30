"""Auto-crop and perspective-rectify a photographed page.

A student's photo of an answer sheet can be shot at any angle -- there is no
scanning app in the loop, so the pipeline itself has to recover a flat page
before OCR ever sees it (`extraction/preprocess.py`'s deskew only corrects
in-plane rotation, not the keystone distortion an angled phone shot produces).

This runs once, at rasterisation time (`pdf.py::render_pages`), before
anything else treats the image as "the page" -- so the coordinate contract in
`extraction/ir.py` needs no changes: the rectified image simply becomes the
original page for every downstream stage.

Only meaningful for a page that started life as a photo (SCANNED/IMAGE
classification); a native PDF page is already a perfect rectangle. cv2 is
imported lazily so the package stays importable without it installed, the
same pattern every other heavy/optional dependency in this codebase follows.
"""
from __future__ import annotations

from dataclasses import dataclass

# A found quadrilateral must cover at least this fraction of the frame to be
# trusted as "the page" rather than a smaller rectangular object in the shot
# (a book, a phone, a desk edge). Below this, leave the image untouched.
MIN_PAGE_AREA_RATIO = 0.25
# Above this, the "quadrilateral" is almost certainly the image frame itself
# rather than a real page edge -- a page with any visible margin around it
# never fills the shot edge-to-edge this cleanly. Dense edge noise (heavy
# background clutter, a cluttered desk) reliably collapses to one big blob
# covering the whole frame with high solidity; without this cap that blob
# passes every other check and gets "rectified" into itself, doing nothing
# useful and hiding a real detection failure behind a false success.
MAX_PAGE_AREA_RATIO = 0.95
# The contour must be nearly as solid as its own convex hull -- rejects a
# noisy edge soup that only approximates to four points after simplification.
MIN_SOLIDITY = 0.90
# How closely the polygon approximation must hug the contour before it
# counts as "a quadrilateral" rather than some other shape.
_APPROX_EPSILON_RATIO = 0.02


@dataclass(frozen=True)
class RectifyResult:
    image_bytes: bytes
    width: int
    height: int


def auto_rectify(image_bytes: bytes) -> RectifyResult | None:
    """Find the page's quadrilateral boundary and warp it flat.

    Returns None when cv2 is unavailable or no confident quadrilateral is
    found -- callers keep the original image unchanged rather than risk a bad
    crop. No pipeline step may require this to succeed.
    """
    if not image_bytes:
        return None
    try:
        import cv2
        import numpy as np
    except ImportError:  # pragma: no cover - environment dependent
        return None

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    try:
        image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    except cv2.error:
        return None
    if image is None:
        return None

    quad = _find_page_quad(image, cv2, np)
    if quad is None:
        return None

    warped = _warp_to_quad(image, quad, cv2, np)
    if warped is None:
        return None

    ok, buffer = cv2.imencode(".png", warped)
    if not ok:
        return None
    height, width = warped.shape[:2]
    return RectifyResult(image_bytes=buffer.tobytes(), width=width, height=height)


def _find_page_quad(image, cv2, np):
    """The largest convex quadrilateral in the frame, or None."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    frame_area = image.shape[0] * image.shape[1]
    best, best_area = None, 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        area_ratio = area / frame_area
        if area_ratio < MIN_PAGE_AREA_RATIO or area_ratio > MAX_PAGE_AREA_RATIO or area <= best_area:
            continue
        hull_area = cv2.contourArea(cv2.convexHull(contour))
        if hull_area <= 0 or area / hull_area < MIN_SOLIDITY:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, _APPROX_EPSILON_RATIO * perimeter, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            best, best_area = approx.reshape(4, 2).astype(np.float32), area
    return best


def _order_corners(points, np):
    """Order four points as [top-left, top-right, bottom-right, bottom-left].

    Sum (x+y) is smallest at top-left and largest at bottom-right; the
    difference (y-x) is smallest at top-right and largest at bottom-left --
    true regardless of the order `approxPolyDP` happened to return them in.
    """
    total = points.sum(axis=1)
    diff = np.diff(points, axis=1).reshape(-1)
    top_left = points[np.argmin(total)]
    bottom_right = points[np.argmax(total)]
    top_right = points[np.argmin(diff)]
    bottom_left = points[np.argmax(diff)]
    return np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)


def _warp_to_quad(image, quad, cv2, np):
    top_left, top_right, bottom_right, bottom_left = _order_corners(quad, np)

    out_width = int(round(max(
        np.linalg.norm(top_right - top_left), np.linalg.norm(bottom_right - bottom_left)
    )))
    out_height = int(round(max(
        np.linalg.norm(bottom_left - top_left), np.linalg.norm(bottom_right - top_right)
    )))
    if out_width < 10 or out_height < 10:
        return None

    destination = np.array(
        [[0, 0], [out_width - 1, 0], [out_width - 1, out_height - 1], [0, out_height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(
        np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32), destination
    )
    return cv2.warpPerspective(image, matrix, (out_width, out_height))
