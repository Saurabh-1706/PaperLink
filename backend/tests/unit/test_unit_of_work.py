"""Unit of Work: identity map, dirty check, deletes, and the org-scope assertions."""
from __future__ import annotations

import pytest

from app.core.errors import NotFoundError
from app.db.models import Assessment, User
from app.db.repositories import AssessmentRepository, UserRepository


def _assessment(org: str = "org-a", title: str = "Paper") -> Assessment:
    return Assessment(organization_id=org, title=title)


def test_add_then_mutate_writes_once_flushed(session):
    repository = AssessmentRepository(session)
    assessment = repository.add(_assessment())

    assessment.title = "Renamed"
    session.commit()

    session.expire_all()
    assert repository.get_or_404("org-a", assessment.id).title == "Renamed"


def test_unchanged_entities_are_not_rewritten(session, mongo_db):
    repository = AssessmentRepository(session)
    assessment = repository.add(_assessment())
    session.commit()
    stored = mongo_db["assessments"].find_one({"_id": assessment.id})

    repository.get_or_404("org-a", assessment.id)
    session.commit()

    assert mongo_db["assessments"].find_one({"_id": assessment.id})["updated_at"] == stored[
        "updated_at"
    ]


def test_two_reads_return_the_same_instance(session):
    repository = AssessmentRepository(session)
    assessment = repository.add(_assessment())
    session.commit()
    session.expire_all()

    first = repository.get_or_404("org-a", assessment.id)
    second = repository.get_or_404("org-a", assessment.id)
    assert first is second


def test_delete_removes_the_document(session, mongo_db):
    repository = AssessmentRepository(session)
    assessment = repository.add(_assessment())
    session.commit()

    repository.delete("org-a", assessment.id)
    session.commit()

    assert mongo_db["assessments"].count_documents({"_id": assessment.id}) == 0


def test_another_org_cannot_read_or_delete(session):
    repository = AssessmentRepository(session)
    assessment = repository.add(_assessment())
    session.commit()

    assert repository.get("org-b", assessment.id) is None
    with pytest.raises(NotFoundError):
        repository.get_or_404("org-b", assessment.id)
    with pytest.raises(NotFoundError):
        repository.delete("org-b", assessment.id)


def test_a_query_without_an_organization_is_a_programming_error(session):
    with pytest.raises(AssertionError):
        AssessmentRepository(session).list("")


def test_an_entity_without_an_organization_is_never_persisted(session):
    with pytest.raises(AssertionError):
        AssessmentRepository(session).add(Assessment(title="Orphan"))


def test_login_lookup_is_the_only_unscoped_read(session):
    repository = UserRepository(session)
    repository.add(
        User(organization_id="org-a", email="teacher@orga.example.com", hashed_password="x", role="teacher")
    )
    session.commit()

    assert repository.by_email("teacher@orga.example.com") is not None
    assert repository.by_email("nobody@orga.example.com") is None
