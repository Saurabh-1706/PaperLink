"""The ONLY place in the backend that converts coordinates.

docs/03-coordinate-contract.md. Two responsibilities:

1. pixel/point space -> normalised [0,1] page space, and the inverse.
2. composing and inverting preprocessing transforms, so a box produced by OCR in
   preprocessed-image space is returned to original page space before it is stored.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from app.schemas.common import BBox

Point = tuple[float, float]


@dataclass(frozen=True)
class Transform:
    """Affine map from ORIGINAL page pixel space to PREPROCESSED image pixel space.

    Stored row-major as (a, b, c, d, e, f) meaning:
        x' = a*x + b*y + c
        y' = d*x + e*y + f
    """

    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 0.0
    e: float = 1.0
    f: float = 0.0

    @classmethod
    def identity(cls) -> Transform:
        return cls()

    @classmethod
    def scaling(cls, sx: float, sy: float) -> Transform:
        if sx <= 0 or sy <= 0:
            raise ValueError("scale factors must be positive")
        return cls(a=sx, e=sy)

    @classmethod
    def translation(cls, tx: float, ty: float) -> Transform:
        return cls(c=tx, f=ty)

    @classmethod
    def rotation(cls, degrees: float, cx: float, cy: float) -> Transform:
        """Rotation by `degrees` (clockwise-positive, matching deskew angles) about a centre."""
        rad = math.radians(degrees)
        cos, sin = math.cos(rad), math.sin(rad)
        return cls(
            a=cos, b=-sin, c=cx - cos * cx + sin * cy,
            d=sin, e=cos, f=cy - sin * cx - cos * cy,
        )

    def then(self, other: Transform) -> Transform:
        """Self followed by `other` (i.e. other ∘ self)."""
        return Transform(
            a=other.a * self.a + other.b * self.d,
            b=other.a * self.b + other.b * self.e,
            c=other.a * self.c + other.b * self.f + other.c,
            d=other.d * self.a + other.e * self.d,
            e=other.d * self.b + other.e * self.e,
            f=other.d * self.c + other.e * self.f + other.f,
        )

    def apply(self, point: Point) -> Point:
        x, y = point
        return (self.a * x + self.b * y + self.c, self.d * x + self.e * y + self.f)

    def invert(self) -> Transform:
        det = self.a * self.e - self.b * self.d
        if abs(det) < 1e-12:
            raise ValueError("transform is not invertible")
        ia, ib = self.e / det, -self.b / det
        id_, ie = -self.d / det, self.a / det
        return Transform(
            a=ia, b=ib, c=-(ia * self.c + ib * self.f),
            d=id_, e=ie, f=-(id_ * self.c + ie * self.f),
        )


class TransformChain:
    """Records each preprocessing step so the composed transform can be inverted."""

    def __init__(self) -> None:
        self._steps: list[tuple[str, Transform]] = []

    def record(self, name: str, transform: Transform) -> None:
        self._steps.append((name, transform))

    @property
    def steps(self) -> list[str]:
        return [name for name, _ in self._steps]

    def composed(self) -> Transform:
        out = Transform.identity()
        for _, step in self._steps:
            out = out.then(step)
        return out

    def to_original(self, box_px: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        """Map a box from preprocessed-image space back to original page pixel space."""
        inverse = self.composed().invert()
        x1, y1, x2, y2 = box_px
        corners = [inverse.apply(p) for p in ((x1, y1), (x2, y1), (x2, y2), (x1, y2))]
        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        return (min(xs), min(ys), max(xs), max(ys))


def normalize_bbox(
    box_px: tuple[float, float, float, float], page_width: float, page_height: float
) -> BBox:
    """Original page pixel/point space -> normalised [0,1] page space."""
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    x1, y1, x2, y2 = box_px
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    return BBox(
        x1=_clamp(x1 / page_width),
        y1=_clamp(y1 / page_height),
        x2=_clamp(x2 / page_width),
        y2=_clamp(y2 / page_height),
    )


def denormalize_bbox(bbox: BBox, page_width: float, page_height: float) -> tuple[float, float, float, float]:
    """Normalised page space -> pixel/point space against the given dimensions."""
    return (
        bbox.x1 * page_width,
        bbox.y1 * page_height,
        bbox.x2 * page_width,
        bbox.y2 * page_height,
    )


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def safe_normalize(
    box_px: tuple[float, float, float, float], page_width: float, page_height: float
) -> BBox | None:
    """Normalise, returning None instead of raising for degenerate/noise boxes."""
    try:
        return normalize_bbox(box_px, page_width, page_height)
    except ValueError:
        return None
