"""The deployed storage path: binaries in GridFS, in the same database as the metadata."""
from __future__ import annotations

from app.db.models import Assessment
from app.db.repositories import AssessmentRepository
from app.modules.assessments.service import AssessmentService
from app.modules.auth.service import AuthService
from app.modules.documents.service import DocumentService
from app.schemas.common import DocumentKind


def test_full_pipeline_against_gridfs(session, mongo_db, gridfs_storage, question_pdf, answer_pdf):
    auth = AuthService(session)
    organization = auth.create_organization("GridFS School")
    teacher = auth.create_user(organization.id, "t@gridfs.example.com", "pw-123456", "teacher")

    assessment = Assessment(
        organization_id=organization.id, created_by=teacher.id, title="GridFS run"
    )
    AssessmentRepository(session).add(assessment)

    documents = DocumentService(session, gridfs_storage)
    service = AssessmentService(session, gridfs_storage)
    for kind, data in (
        (DocumentKind.QUESTION_PAPER, question_pdf),
        (DocumentKind.ANSWER_SHEET, answer_pdf),
    ):
        result = documents.ingest(
            organization_id=organization.id,
            assessment_id=assessment.id,
            kind=kind,
            data=data,
            created_by=teacher.id,
        )
        assert result.document.storage_uri.startswith("gridfs://")
        service.attach_document(assessment, kind, result.document.id)

    job = service.create_job(organization.id, assessment.id, teacher.id)
    session.commit()
    assert service.process(organization.id, assessment.id, job.id) is True
    session.commit()

    results = service.results(organization.id, assessment.id)
    assert results["mapping_count"] > 0
    # Source PDFs, page images, IR-JSON and markdown all landed in the bucket.
    assert mongo_db["documents.files"].count_documents({}) >= 8


def test_gridfs_reads_are_tenant_checked(gridfs_storage):
    import pytest

    from app.core.errors import NotFoundError

    uri = gridfs_storage.put("org-a/assessment/doc/source.pdf", b"%PDF-1.7 fake")
    assert gridfs_storage.get(uri, organization_id="org-a") == b"%PDF-1.7 fake"
    # Another tenant's read reads as absent, never as forbidden.
    with pytest.raises(NotFoundError):
        gridfs_storage.get(uri, organization_id="org-b")


def test_reingesting_the_same_key_replaces_rather_than_versions(gridfs_storage, mongo_db):
    gridfs_storage.put("org-a/a/d/source.pdf", b"first")
    gridfs_storage.put("org-a/a/d/source.pdf", b"second")
    assert mongo_db["documents.files"].count_documents({"filename": "org-a/a/d/source.pdf"}) == 1
    assert gridfs_storage.get("gridfs://org-a/a/d/source.pdf") == b"second"
