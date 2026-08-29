"""Region assembly for read routes.

A mapped answer that continues onto a later page owns regions on several rows; the UI
must receive all of them, so continuation children are folded in here.
"""
from __future__ import annotations

from app.db.models import Answer
from app.db.repositories import AnswerRegionRepository, AnswerRepository
from app.db.session import UnitOfWork
from app.schemas.common import Region


def answer_regions(
    session: UnitOfWork, organization_id: str, assessment_id: str
) -> dict[str, list[Region]]:
    """Regions per answer id, including every continuation segment of that answer."""
    rows: list[Answer] = AnswerRepository(session).for_assessment(organization_id, assessment_id)
    regions = AnswerRegionRepository(session).for_answers(organization_id, [row.id for row in rows])

    by_row: dict[str, list[Region]] = {}
    for region in regions:
        by_row.setdefault(region.answer_id, []).append(
            Region(page=region.page_number, bbox=region.bbox)
        )

    by_external = {row.external_id: row for row in rows}
    children: dict[str, list[Answer]] = {}
    for row in rows:
        if row.is_continuation_of and row.is_continuation_of in by_external:
            children.setdefault(by_external[row.is_continuation_of].id, []).append(row)

    out: dict[str, list[Region]] = {}
    for row in rows:
        collected = list(by_row.get(row.id, []))
        cursor = [row]
        while cursor:
            current = cursor.pop()
            for child in children.get(current.id, []):
                collected.extend(by_row.get(child.id, []))
                cursor.append(child)
        out[row.id] = sorted(collected, key=lambda region: (region.page, region.bbox.y1))
    return out
