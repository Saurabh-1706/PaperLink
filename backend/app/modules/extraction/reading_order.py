"""Reading order: column detection first, then top-to-bottom, left-to-right.

A naive pure-y sort interleaves the columns of a two-column paper and silently
destroys question boundaries (docs/pipelines/extraction.md, stage 6).
"""
from __future__ import annotations

from app.schemas.common import BBox

# A gap must be this wide (in normalised page units) to count as a column separator.
MIN_COLUMN_GAP = 0.06
# Below this, a page is treated as single-column regardless of gaps.
MIN_BLOCKS_FOR_COLUMNS = 6


def detect_columns(boxes: list[BBox]) -> list[tuple[float, float]]:
    """Return column x-ranges. A single range means the page is single-column."""
    if len(boxes) < MIN_BLOCKS_FOR_COLUMNS:
        return [(0.0, 1.0)]
    spans = sorted((b.x1, b.x2) for b in boxes)
    merged: list[list[float]] = []
    for x1, x2 in spans:
        if merged and x1 <= merged[-1][1] + MIN_COLUMN_GAP:
            merged[-1][1] = max(merged[-1][1], x2)
        else:
            merged.append([x1, x2])
    if len(merged) < 2:
        return [(0.0, 1.0)]
    # Only accept a split when each column carries a meaningful share of the blocks.
    columns = [(m[0], m[1]) for m in merged]
    counts = [sum(1 for b in boxes if _column_index(b, columns) == i) for i in range(len(columns))]
    if min(counts) < max(2, len(boxes) // 10):
        return [(0.0, 1.0)]
    return columns


def _column_index(box: BBox, columns: list[tuple[float, float]]) -> int:
    centre = (box.x1 + box.x2) / 2
    best, best_distance = 0, float("inf")
    for index, (x1, x2) in enumerate(columns):
        if x1 <= centre <= x2:
            return index
        distance = min(abs(centre - x1), abs(centre - x2))
        if distance < best_distance:
            best, best_distance = index, distance
    return best


def order_boxes(boxes: list[BBox]) -> list[int]:
    """Return indices of `boxes` in reading order."""
    if not boxes:
        return []
    columns = detect_columns(boxes)
    keyed = [
        (_column_index(box, columns), round(box.y1, 3), box.x1, index)
        for index, box in enumerate(boxes)
    ]
    keyed.sort()
    return [item[3] for item in keyed]
