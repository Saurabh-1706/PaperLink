"""Celery tasks. Each opens its own session and commits or rolls back as a unit."""
from __future__ import annotations

from app.core.logging import get_logger
from app.db.session import session_scope
from app.modules.assessments.service import AssessmentService
from app.storage.factory import get_storage
from app.workers.celery_app import celery_app

log = get_logger(__name__)


@celery_app.task(name="assessment.process")
def process_assessment(
    organization_id: str, assessment_id: str, job_id: str, remap_only: bool = False
) -> str:
    with session_scope() as session:
        service = AssessmentService(session, get_storage())
        service.process(organization_id, assessment_id, job_id, remap_only=remap_only)
    return job_id


def enqueue_processing(
    organization_id: str, assessment_id: str, job_id: str, remap_only: bool = False
) -> None:
    process_assessment.delay(organization_id, assessment_id, job_id, remap_only)
