"""Stage 6 — global one-to-one assignment (ADR-003).

Greedy per-answer matching lets one strong local match steal an answer another question
needed. The score matrix is solved once, for the whole sheet.
"""
from __future__ import annotations


def solve(matrix: list[list[float]], reject_below: float) -> list[tuple[int, int]]:
    """Return (row, column) pairs maximising total score, dropping pairs below the floor."""
    if not matrix or not matrix[0]:
        return []

    pairs: list[tuple[int, int]] = []
    try:
        import numpy as np
        from scipy.optimize import linear_sum_assignment

        cost = -np.asarray(matrix, dtype=float)
        rows, columns = linear_sum_assignment(cost)
        pairs = [(int(r), int(c)) for r, c in zip(rows, columns)]
    except ImportError:  # pragma: no cover - scipy is a hard dependency in the image
        pairs = _greedy(matrix)

    return [(r, c) for r, c in pairs if matrix[r][c] >= reject_below]


def _greedy(matrix: list[list[float]]) -> list[tuple[int, int]]:
    """Fallback only. Deliberately not the default — see ADR-003."""
    candidates = sorted(
        ((matrix[r][c], r, c) for r in range(len(matrix)) for c in range(len(matrix[0]))),
        reverse=True,
    )
    used_rows: set[int] = set()
    used_columns: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _, row, column in candidates:
        if row in used_rows or column in used_columns:
            continue
        used_rows.add(row)
        used_columns.add(column)
        pairs.append((row, column))
    return pairs
