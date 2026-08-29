"""Reviewer corrections."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.v1.deps import Principal, SessionDep, require
from app.api.v1.regions import answer_regions
from app.core.errors import ValidationFailedError
from app.core.permissions import Permission
from app.db.repositories import AnswerRepository, MappingRepository
from app.schemas.api import MappingOut, MappingPatch
from app.schemas.common import MappingType, ReviewStatus

router = APIRouter(prefix="/mappings", tags=["mappings"])

ReviewDep = Annotated[Principal, Depends(require(Permission.REVIEW_MAPPING))]


@router.patch("/{mapping_id}", response_model=MappingOut)
def correct_mapping(
    mapping_id: str, payload: MappingPatch, principal: ReviewDep, session: SessionDep
) -> MappingOut:
    repository = MappingRepository(session)
    row = repository.get_or_404(principal.organization_id, mapping_id)

    if payload.answer_id is not None:
        answer = AnswerRepository(session).get_or_404(principal.organization_id, payload.answer_id)
        if answer.assessment_id != row.assessment_id:
            raise ValidationFailedError("The answer belongs to a different assessment.")
        row.answer_id = answer.id
        row.review_status = str(ReviewStatus.HUMAN_CORRECTED)
        if row.question_id and row.mapping_type == str(MappingType.UNANSWERED):
            row.mapping_type = str(MappingType.DIRECT)
    elif payload.review_status is not None:
        try:
            row.review_status = str(ReviewStatus(payload.review_status))
        except ValueError as exc:
            raise ValidationFailedError("Unknown review_status.", value=payload.review_status) from exc
    else:
        raise ValidationFailedError("Provide answer_id or review_status.")

    evidence = dict(row.evidence or {})
    evidence["corrected_by"] = principal.user_id
    row.evidence = evidence
    session.commit()

    regions = answer_regions(session, principal.organization_id, row.assessment_id).get(
        row.answer_id or "", []
    )
    return MappingOut(
        id=row.id,
        question_id=row.question_id,
        answer_id=row.answer_id,
        mapping_type=row.mapping_type,
        confidence=row.confidence,
        review_status=row.review_status,
        evidence=row.evidence or {},
        regions=regions,
    )
