"""Ingestion against the GridFS backend: the binaries and the metadata land together."""
from __future__ import annotations

from app.db.repositories import DocumentRepository, PageRepository
from app.modules.documents.service import DocumentService
from app.schemas.common import DocumentKind

ORG = "org-a"
ASSESSMENT = "assessment-1"


def test_ingest_stores_source_pages_and_ir_in_gridfs(session, gridfs_storage, mongo_db, question_pdf):
    service = DocumentService(session, gridfs_storage)

    result = service.ingest(
        organization_id=ORG,
        assessment_id=ASSESSMENT,
        kind=DocumentKind.QUESTION_PAPER,
        data=question_pdf,
        created_by="user-1",
    )
    session.commit()

    document = result.document
    assert document.storage_uri.startswith("gridfs://")
    assert gridfs_storage.get(document.storage_uri, organization_id=ORG) == question_pdf
    assert gridfs_storage.exists(document.ir_uri)
    assert gridfs_storage.exists(document.markdown_uri)

    pages = PageRepository(session).for_document(ORG, document.id)
    assert pages
    for page in pages:
        assert gridfs_storage.exists(page.rendered_image_uri)

    # Every stored object is traceable to its tenant without reading the key.
    owners = mongo_db["documents.files"].distinct("metadata.organization_id")
    assert owners == [ORG]

    # And the metadata round-trips through Mongo, not just through memory.
    session.expire_all()
    stored = DocumentRepository(session).get_or_404(ORG, document.id)
    assert stored.checksum == document.checksum
    assert stored.page_count == document.page_count
    assert service.load_ir(stored).page_count == document.page_count


def test_reuploading_the_same_file_is_idempotent(session, gridfs_storage, mongo_db, question_pdf):
    service = DocumentService(session, gridfs_storage)
    common = {
        "organization_id": ORG,
        "assessment_id": ASSESSMENT,
        "kind": DocumentKind.QUESTION_PAPER,
        "data": question_pdf,
    }

    first = service.ingest(**common)
    session.commit()
    file_count = mongo_db["documents.files"].count_documents({})

    second = service.ingest(**common)
    session.commit()

    assert second.created is False
    assert second.document.id == first.document.id
    assert mongo_db["documents.files"].count_documents({}) == file_count
    assert mongo_db["documents"].count_documents({"assessment_id": ASSESSMENT}) == 1
