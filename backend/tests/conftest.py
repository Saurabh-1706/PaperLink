from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest

os.environ.setdefault("MONGO_DB_NAME", "assessment_test")
os.environ.setdefault("MONGO_TRANSACTIONS", "false")
os.environ.setdefault("STORAGE_BACKEND", "local")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CELERY_TASK_ALWAYS_EAGER", "true")
os.environ.setdefault("OCR_ENGINE", "stub")
os.environ.setdefault("LLM_PROVIDER", "null")


@pytest.fixture(scope="session", autouse=True)
def _storage_root() -> Iterator[str]:
    root = tempfile.mkdtemp(prefix="assessment-test-")
    from app.core.config import settings
    from app.storage.factory import get_storage

    settings.storage_path = root
    get_storage.cache_clear()
    yield root


@pytest.fixture
def mongo_db(monkeypatch) -> Iterator:
    """A fresh in-memory MongoDB per test.

    `mongomock` keeps the suite hermetic (no server, no network) while running the same
    pymongo calls the deployed code makes. Anything that needs genuine server behaviour
    — transactions, real index enforcement — belongs in a test marked for a live mongod.
    """
    import mongomock
    import mongomock.gridfs

    import app.db.session as session_module

    mongomock.gridfs.enable_gridfs_integration()
    client = mongomock.MongoClient()
    database = client["assessment_test"]
    session_module.ensure_indexes(database)
    monkeypatch.setattr(session_module, "get_client", lambda: client)
    monkeypatch.setattr(session_module, "get_database", lambda: database)
    yield database
    client.close()


@pytest.fixture
def session(mongo_db) -> Iterator:
    """A Unit of Work bound to the per-test database, shared by API and worker code."""
    from app.db.session import UnitOfWork

    unit = UnitOfWork(mongo_db, use_transaction=False)
    try:
        yield unit
    finally:
        unit.close()


@pytest.fixture
def storage(_storage_root: str):
    from app.storage.local import LocalStorage

    return LocalStorage(_storage_root)


@pytest.fixture
def gridfs_storage(mongo_db):
    from app.storage.gridfs import GridFSStorage

    return GridFSStorage(mongo_db, "documents")


@pytest.fixture
def question_pdf() -> bytes:
    from tests.fixtures.generator import question_paper_pdf

    return question_paper_pdf()


@pytest.fixture
def answer_pdf() -> bytes:
    from tests.fixtures.generator import answer_sheet_pdf

    return answer_sheet_pdf()


@pytest.fixture
def client(session, _storage_root):
    """TestClient wired to the per-test session and storage."""
    from fastapi.testclient import TestClient

    import app.api.v1.assessments as assessments_api
    from app.db.session import get_session
    from app.main import app
    from app.modules.assessments.service import AssessmentService
    from app.storage.factory import get_storage
    from app.storage.local import LocalStorage

    local = LocalStorage(_storage_root)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_storage] = lambda: local

    # The Celery worker would open its own session against its own engine; in tests the
    # work runs inline against the per-test session instead.
    original = assessments_api.enqueue_processing

    def run_inline(organization_id: str, assessment_id: str, job_id: str, remap_only: bool = False) -> None:
        AssessmentService(session, local).process(
            organization_id, assessment_id, job_id, remap_only=remap_only
        )
        session.commit()

    assessments_api.enqueue_processing = run_inline
    with TestClient(app) as test_client:
        yield test_client
    assessments_api.enqueue_processing = original
    app.dependency_overrides.clear()


@pytest.fixture
def org_with_users(session):
    """One org with an admin, a teacher and a reviewer; plus a second, rival org."""
    from app.core.permissions import Role
    from app.modules.auth.service import AuthService

    service = AuthService(session)
    org_a = service.create_organization("Org A")
    org_b = service.create_organization("Org B")
    users = {
        "admin": service.create_user(org_a.id, "admin@orga.example.com", "pw-admin-1", Role.ADMIN),
        "teacher": service.create_user(org_a.id, "teacher@orga.example.com", "pw-teacher-1", Role.TEACHER),
        "reviewer": service.create_user(org_a.id, "reviewer@orga.example.com", "pw-reviewer-1", Role.REVIEWER),
        "intruder": service.create_user(org_b.id, "teacher@orgb.example.com", "pw-intruder-1", Role.TEACHER),
    }
    session.commit()
    return {"org_a": org_a, "org_b": org_b, "users": users}


@pytest.fixture
def tokens(org_with_users):
    from app.core.security import create_access_token

    users = org_with_users["users"]
    return {
        name: create_access_token(user.id, user.organization_id, user.role)
        for name, user in users.items()
    }


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
