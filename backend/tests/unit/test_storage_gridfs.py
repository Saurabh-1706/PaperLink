"""GridFS backend: URI round-trip, tenant scoping, replace-on-rewrite."""
from __future__ import annotations

import pytest

from app.core.errors import NotFoundError

ORG = "org-a"
KEY = f"{ORG}/assessment-1/document-1/source.pdf"


def test_put_returns_a_uri_that_reads_back(gridfs_storage):
    uri = gridfs_storage.put(KEY, b"%PDF-1.7 body")

    assert uri == f"gridfs://{KEY}"
    assert gridfs_storage.get(uri) == b"%PDF-1.7 body"
    assert gridfs_storage.exists(uri)


def test_metadata_records_the_owner(gridfs_storage, mongo_db):
    gridfs_storage.put(KEY, b"bytes", {"assessment_id": "assessment-1", "kind": "answer_sheet"})

    stored = mongo_db["documents.files"].find_one({"filename": KEY})
    assert stored["metadata"]["organization_id"] == ORG
    assert stored["metadata"]["kind"] == "answer_sheet"


def test_another_tenant_gets_not_found_never_forbidden(gridfs_storage):
    uri = gridfs_storage.put(KEY, b"bytes")

    with pytest.raises(NotFoundError):
        gridfs_storage.get(uri, organization_id="org-b")
    assert gridfs_storage.get(uri, organization_id=ORG) == b"bytes"


def test_rewriting_a_key_replaces_it_rather_than_versioning(gridfs_storage, mongo_db):
    gridfs_storage.put(KEY, b"first")
    gridfs_storage.put(KEY, b"second")

    assert gridfs_storage.get(KEY) == b"second"
    assert mongo_db["documents.files"].count_documents({"filename": KEY}) == 1


def test_delete_removes_the_object(gridfs_storage):
    uri = gridfs_storage.put(KEY, b"bytes")
    gridfs_storage.delete(uri)

    assert not gridfs_storage.exists(uri)
    with pytest.raises(NotFoundError):
        gridfs_storage.get(uri)
