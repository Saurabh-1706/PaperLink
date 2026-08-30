"""Assessment routes. Handlers enqueue and read — nothing heavy runs inline."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile, status

from app.api.v1.deps import Principal, SessionDep, StorageDep, require
from app.api.v1.regions import answer_regions
from app.core.permissions import Permission
from app.db.models import Assessment
from app.db.repositories import (
    AnswerRegionRepository,
    AnswerRepository,
    AssessmentRepository,
    GradeRepository,
    JobRepository,
    MappingRepository,
    QuestionRegionRepository,
    QuestionRepository,
)
from app.modules.assessments.service import AssessmentService
from app.modules.documents.service import DocumentService
from app.modules.documents.validation import normalize_upload_to_pdf
from app.schemas.api import (
    AnswerOut,
    AssessmentOut,
    CreateAssessmentRequest,
    DocumentOut,
    GradeBreakdownOut,
    GradeOut,
    JobOut,
    MappingOut,
    QuestionOut,
    ResultsOut,
)
from app.schemas.common import DocumentKind, Region
from app.workers.tasks import enqueue_processing

router = APIRouter(prefix="/assessments", tags=["assessments"])

ReadDep = Annotated[Principal, Depends(require(Permission.READ))]
UploadDep = Annotated[Principal, Depends(require(Permission.UPLOAD_DOCUMENT))]
ProcessDep = Annotated[Principal, Depends(require(Permission.TRIGGER_PROCESSING))]
CreateDep = Annotated[Principal, Depends(require(Permission.CREATE_ASSESSMENT))]
ReviewDep = Annotated[Principal, Depends(require(Permission.REVIEW_MAPPING))]


@router.post("", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(
    payload: CreateAssessmentRequest, principal: CreateDep, session: SessionDep
) -> AssessmentOut:
    assessment = Assessment(
        organization_id=principal.organization_id,
        created_by=principal.user_id,
        title=payload.title,
    )
    AssessmentRepository(session).add(assessment)
    session.commit()
    return _assessment_out(assessment)


@router.get("/{assessment_id}", response_model=AssessmentOut)
def get_assessment(assessment_id: str, principal: ReadDep, session: SessionDep) -> AssessmentOut:
    assessment = AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    return _assessment_out(assessment)


@router.post("/{assessment_id}/question-paper", status_code=status.HTTP_202_ACCEPTED)
def upload_question_paper(
    assessment_id: str,
    principal: UploadDep,
    session: SessionDep,
    storage: StorageDep,
    files: Annotated[list[UploadFile], File()],
) -> DocumentOut:
    return _upload(assessment_id, principal, session, storage, files, DocumentKind.QUESTION_PAPER)


@router.post("/{assessment_id}/answer-sheet", status_code=status.HTTP_202_ACCEPTED)
def upload_answer_sheet(
    assessment_id: str,
    principal: UploadDep,
    session: SessionDep,
    storage: StorageDep,
    files: Annotated[list[UploadFile], File()],
) -> DocumentOut:
    return _upload(assessment_id, principal, session, storage, files, DocumentKind.ANSWER_SHEET)


def _upload(
    assessment_id: str,
    principal: Principal,
    session,
    storage,
    files: list[UploadFile],
    kind: DocumentKind,
) -> DocumentOut:
    assessment = AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    # A single PDF, or one-or-more JPEG/PNG photos (one per page) -- either way this
    # always comes out as one PDF blob, so nothing past this line needs to know which
    # the upload actually was.
    uploads = [(f.filename or "", f.file.read()) for f in files]
    data, declared_mime = normalize_upload_to_pdf(uploads)
    service = DocumentService(session, storage)
    result = service.ingest(
        organization_id=principal.organization_id,
        assessment_id=assessment.id,
        kind=kind,
        data=data,
        created_by=principal.user_id,
        declared_mime=declared_mime,
    )
    AssessmentService(session, storage).attach_document(assessment, kind, result.document.id)
    session.commit()
    return DocumentOut(
        document_id=result.document.id,
        kind=result.document.kind,
        page_count=result.document.page_count,
        classification=result.document.classification,
        created=result.created,
    )


@router.post("/{assessment_id}/process", status_code=status.HTTP_202_ACCEPTED, response_model=JobOut)
def process(assessment_id: str, principal: ProcessDep, session: SessionDep, storage: StorageDep) -> JobOut:
    return _enqueue(assessment_id, principal, session, storage, remap_only=False)


@router.post("/{assessment_id}/remap", status_code=status.HTTP_202_ACCEPTED, response_model=JobOut)
def remap(assessment_id: str, principal: ProcessDep, session: SessionDep, storage: StorageDep) -> JobOut:
    """Re-runs mapping only: a threshold change must not force re-OCR of a 40-page scan."""
    return _enqueue(assessment_id, principal, session, storage, remap_only=True)


def _enqueue(assessment_id: str, principal: Principal, session, storage, remap_only: bool) -> JobOut:
    assessment = AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    service = AssessmentService(session, storage)
    job = service.create_job(principal.organization_id, assessment.id, principal.user_id)
    session.commit()
    enqueue_processing(principal.organization_id, assessment.id, job.id, remap_only)
    session.expire_all()
    job = JobRepository(session).get_or_404(principal.organization_id, job.id)
    return _job_out(job)


@router.get("/{assessment_id}/jobs/{job_id}", response_model=JobOut)
def job_status(assessment_id: str, job_id: str, principal: ReadDep, session: SessionDep) -> JobOut:
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    job = JobRepository(session).get_or_404(principal.organization_id, job_id)
    return _job_out(job)


@router.get("/{assessment_id}/questions", response_model=list[QuestionOut])
def list_questions(assessment_id: str, principal: ReadDep, session: SessionDep) -> list[QuestionOut]:
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    rows = QuestionRepository(session).for_assessment(principal.organization_id, assessment_id)
    regions = QuestionRegionRepository(session).for_questions(
        principal.organization_id, [row.id for row in rows]
    )
    grouped: dict[str, list[Region]] = {}
    for region in regions:
        grouped.setdefault(region.question_id, []).append(
            Region(page=region.page_number, bbox=region.bbox)
        )
    return [
        QuestionOut(
            id=row.id,
            display_number=row.display_number,
            normalized_number=row.normalized_number,
            parent_id=row.parent_id,
            text=row.text,
            order_index=row.order_index,
            optional=row.optional,
            max_marks=row.max_marks,
            confidence=row.confidence,
            pages=sorted({region.page for region in grouped.get(row.id, [])}),
            regions=grouped.get(row.id, []),
        )
        for row in rows
    ]


@router.get("/{assessment_id}/answers", response_model=list[AnswerOut])
def list_answers(assessment_id: str, principal: ReadDep, session: SessionDep) -> list[AnswerOut]:
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    rows = AnswerRepository(session).for_assessment(principal.organization_id, assessment_id)
    regions = AnswerRegionRepository(session).for_answers(
        principal.organization_id, [row.id for row in rows]
    )
    grouped: dict[str, list[Region]] = {}
    for region in regions:
        grouped.setdefault(region.answer_id, []).append(
            Region(page=region.page_number, bbox=region.bbox)
        )
    return [
        AnswerOut(
            id=row.id,
            raw_text=row.raw_text,
            normalized_text=row.normalized_text,
            detected_label=row.detected_label,
            confidence=row.confidence,
            extraction_method=row.extraction_method,
            is_continuation_of=row.is_continuation_of,
            pages=sorted({region.page for region in grouped.get(row.id, [])}),
            regions=grouped.get(row.id, []),
        )
        for row in rows
    ]


@router.get("/{assessment_id}/mappings", response_model=list[MappingOut])
def list_mappings(
    assessment_id: str,
    principal: ReadDep,
    session: SessionDep,
    review_status: Annotated[str | None, Query()] = None,
) -> list[MappingOut]:
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    rows = MappingRepository(session).for_assessment(
        principal.organization_id, assessment_id, review_status
    )
    # Multi-page answers own regions on their continuation rows too.
    grouped = answer_regions(session, principal.organization_id, assessment_id)
    return [
        MappingOut(
            id=row.id,
            question_id=row.question_id,
            answer_id=row.answer_id,
            mapping_type=row.mapping_type,
            confidence=row.confidence,
            review_status=row.review_status,
            evidence=row.evidence or {},
            regions=grouped.get(row.answer_id or "", []),
        )
        for row in rows
    ]


@router.get("/{assessment_id}/grades", response_model=list[GradeOut])
def list_grades(assessment_id: str, principal: ReadDep, session: SessionDep) -> list[GradeOut]:
    """Per-mapping scores. `results` is the aggregate; this is what a review UI needs
    to show a mark against the question it belongs to."""
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    rows = MappingRepository(session).for_assessment(principal.organization_id, assessment_id)
    grades = GradeRepository(session).for_mappings(
        principal.organization_id, [row.id for row in rows]
    )
    return [
        GradeOut(
            id=grade.id,
            mapping_id=grade.mapping_id,
            score=grade.score,
            max_score=grade.max_score,
            breakdown=[
                GradeBreakdownOut(**item) for item in (grade.rubric or {}).get("breakdown", [])
            ],
            feedback=grade.feedback,
            method=grade.method,
        )
        for grade in grades
    ]


@router.get("/{assessment_id}/results", response_model=ResultsOut)
def results(assessment_id: str, principal: ReadDep, session: SessionDep, storage: StorageDep) -> ResultsOut:
    AssessmentRepository(session).get_or_404(principal.organization_id, assessment_id)
    return ResultsOut(**AssessmentService(session, storage).results(principal.organization_id, assessment_id))


def _assessment_out(assessment: Assessment) -> AssessmentOut:
    return AssessmentOut(
        id=assessment.id,
        title=assessment.title,
        status=assessment.status,
        question_doc_id=assessment.question_doc_id,
        answer_doc_id=assessment.answer_doc_id,
    )


def _job_out(job) -> JobOut:
    return JobOut(
        job_id=job.id,
        assessment_id=job.assessment_id,
        stage=job.stage,
        status=job.status,
        progress=job.progress,
        error=job.error,
    )
