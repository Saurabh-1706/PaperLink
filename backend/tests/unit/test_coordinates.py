"""Bounding-box math and transform inversion — the safety-critical path."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.modules.extraction.ir import (
    Transform,
    TransformChain,
    denormalize_bbox,
    normalize_bbox,
    safe_normalize,
)
from app.schemas.common import BBox, Region


def test_normalize_is_relative_to_original_page_dimensions():
    bbox = normalize_bbox((100, 200, 300, 400), page_width=1000, page_height=2000)
    assert bbox.as_list() == [0.1, 0.1, 0.3, 0.2]


def test_normalize_denormalize_round_trip():
    original = (12.5, 44.0, 300.25, 91.5)
    bbox = normalize_bbox(original, 595, 842)
    back = denormalize_bbox(bbox, 595, 842)
    assert back == pytest.approx(original, abs=1e-6)


def test_degenerate_box_is_a_validation_failure():
    with pytest.raises(ValidationError):
        BBox(x1=0.5, y1=0.2, x2=0.5, y2=0.4)
    with pytest.raises(ValidationError):
        BBox(x1=0.6, y1=0.2, x2=0.3, y2=0.4)


def test_safe_normalize_returns_none_for_noise():
    assert safe_normalize((10, 10, 10, 10), 100, 100) is None


def test_out_of_range_values_are_clamped_not_stored_raw():
    bbox = normalize_bbox((-20, -5, 1200, 900), 1000, 800)
    assert bbox.as_list() == [0.0, 0.0, 1.0, 1.0]


def test_scaling_transform_inverts_exactly():
    chain = TransformChain()
    chain.record("resize", Transform.scaling(2.0, 2.0))
    assert chain.to_original((20, 40, 60, 80)) == pytest.approx((10, 20, 30, 40))


def test_composed_transform_inverts_to_original_space():
    chain = TransformChain()
    chain.record("deskew", Transform.rotation(-3.0, 500, 400))
    chain.record("resize", Transform.scaling(0.5, 0.5))

    box = (100.0, 120.0, 300.0, 180.0)
    forward = chain.composed()
    corners = [forward.apply(point) for point in ((box[0], box[1]), (box[2], box[3]))]
    projected = (
        min(corners[0][0], corners[1][0]),
        min(corners[0][1], corners[1][1]),
        max(corners[0][0], corners[1][0]),
        max(corners[0][1], corners[1][1]),
    )
    recovered = chain.to_original(projected)
    # Rotation of an axis-aligned box grows it slightly; it must still contain the original.
    assert recovered[0] <= box[0] + 1e-6
    assert recovered[1] <= box[1] + 1e-6
    assert recovered[2] >= box[2] - 1e-6
    assert recovered[3] >= box[3] - 1e-6


def test_identity_chain_is_a_no_op():
    chain = TransformChain()
    chain.record("grayscale", Transform.identity())
    assert chain.to_original((1, 2, 3, 4)) == pytest.approx((1, 2, 3, 4))


def test_union_and_iou():
    a = BBox(x1=0.1, y1=0.1, x2=0.5, y2=0.5)
    b = BBox(x1=0.4, y1=0.4, x2=0.9, y2=0.9)
    assert a.union(b).as_list() == [0.1, 0.1, 0.9, 0.9]
    assert a.iou(a) == pytest.approx(1.0)
    assert 0.0 < a.iou(b) < 0.1


def test_region_accepts_a_raw_list_and_rejects_page_zero():
    region = Region(page=3, bbox=[0.1, 0.2, 0.3, 0.4])
    assert region.bbox.x1 == 0.1
    with pytest.raises(ValidationError):
        Region(page=0, bbox=[0.1, 0.2, 0.3, 0.4])
