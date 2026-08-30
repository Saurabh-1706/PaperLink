"""Cross-tenant isolation across every route, plus the role matrix.

Phase 1 exit criterion: org B gets 404 — never 403 — on every org A resource.
"""
from __future__ import annotations

import pytest

from app.core.permissions import Permission, Role, has_permission
from app.db.repositories import AssessmentRepository
from tests.conftest import auth_header


@pytest.fixture
def org_a_assessment(client, tokens, question_pdf, answer_pdf) -> dict:
    token = tokens["teacher"]
    assessment_id = client.post(
        "/api/v1/assessments", json={"title": "Org A paper"}, headers=auth_header(token)
    ).json()["id"]
    question_doc = client.post(
        f"/api/v1/assessments/{assessment_id}/question-paper",
        files={"files": ("q.pdf", question_pdf, "application/pdf")},
        headers=auth_header(token),
    ).json()
    client.post(
        f"/api/v1/assessments/{assessment_id}/answer-sheet",
        files={"files": ("a.pdf", answer_pdf, "application/pdf")},
        headers=auth_header(token),
    )
    job = client.post(
        f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token)
    ).json()
    mappings = client.get(
        f"/api/v1/assessments/{assessment_id}/mappings", headers=auth_header(token)
    ).json()
    return {
        "assessment_id": assessment_id,
        "document_id": question_doc["document_id"],
        "job_id": job["job_id"],
        "mapping_id": mappings[0]["id"],
    }


def test_every_route_returns_404_for_another_org(client, tokens, org_a_assessment, question_pdf):
    intruder = auth_header(tokens["intruder"])
    assessment_id = org_a_assessment["assessment_id"]
    document_id = org_a_assessment["document_id"]

    gets = [
        f"/api/v1/assessments/{assessment_id}",
        f"/api/v1/assessments/{assessment_id}/questions",
        f"/api/v1/assessments/{assessment_id}/answers",
        f"/api/v1/assessments/{assessment_id}/mappings",
        f"/api/v1/assessments/{assessment_id}/results",
        f"/api/v1/assessments/{assessment_id}/jobs/{org_a_assessment['job_id']}",
        f"/api/v1/documents/{document_id}/pages/1/image",
        f"/api/v1/documents/{document_id}/markdown",
    ]
    for url in gets:
        response = client.get(url, headers=intruder)
        assert response.status_code == 404, f"{url} leaked with {response.status_code}"
        assert response.json()["error"]["code"] == "NOT_FOUND"

    posts = [
        f"/api/v1/assessments/{assessment_id}/process",
        f"/api/v1/assessments/{assessment_id}/remap",
    ]
    for url in posts:
        assert client.post(url, headers=intruder).status_code == 404

    upload = client.post(
        f"/api/v1/assessments/{assessment_id}/question-paper",
        files={"files": ("q.pdf", question_pdf, "application/pdf")},
        headers=intruder,
    )
    assert upload.status_code == 404

    patch = client.patch(
        f"/api/v1/mappings/{org_a_assessment['mapping_id']}",
        json={"review_status": "human_confirmed"},
        headers=intruder,
    )
    assert patch.status_code == 404


def test_page_image_is_as_protected_as_the_text(client, tokens, org_a_assessment):
    url = f"/api/v1/documents/{org_a_assessment['document_id']}/pages/1/image"
    assert client.get(url, headers=auth_header(tokens["teacher"])).status_code == 200
    assert client.get(url, headers=auth_header(tokens["intruder"])).status_code == 404


def test_reviewer_cannot_upload_but_can_resolve_review(client, tokens, org_a_assessment, question_pdf):
    reviewer = auth_header(tokens["reviewer"])
    assessment_id = org_a_assessment["assessment_id"]

    upload = client.post(
        f"/api/v1/assessments/{assessment_id}/question-paper",
        files={"files": ("q.pdf", question_pdf, "application/pdf")},
        headers=reviewer,
    )
    assert upload.status_code == 403
    assert upload.json()["error"]["code"] == "PERMISSION_DENIED"

    assert client.post(
        "/api/v1/assessments", json={"title": "nope"}, headers=reviewer
    ).status_code == 403

    assert client.get(
        f"/api/v1/assessments/{assessment_id}/mappings", headers=reviewer
    ).status_code == 200

    patched = client.patch(
        f"/api/v1/mappings/{org_a_assessment['mapping_id']}",
        json={"review_status": "human_confirmed"},
        headers=reviewer,
    )
    assert patched.status_code == 200
    assert patched.json()["review_status"] == "human_confirmed"


def test_reviewer_correction_relinks_the_answer(client, tokens, org_a_assessment):
    reviewer = auth_header(tokens["reviewer"])
    assessment_id = org_a_assessment["assessment_id"]
    answers = client.get(
        f"/api/v1/assessments/{assessment_id}/answers", headers=reviewer
    ).json()
    target = answers[-1]["id"]
    patched = client.patch(
        f"/api/v1/mappings/{org_a_assessment['mapping_id']}",
        json={"answer_id": target},
        headers=reviewer,
    ).json()
    assert patched["answer_id"] == target
    assert patched["review_status"] == "human_corrected"
    assert patched["evidence"]["corrected_by"]


def test_missing_or_bad_token_is_401(client, org_a_assessment):
    url = f"/api/v1/assessments/{org_a_assessment['assessment_id']}"
    assert client.get(url).status_code == 401
    assert client.get(url, headers=auth_header("garbage")).status_code == 401


def test_login_issues_tokens_and_rejects_bad_passwords(client, org_with_users):
    good = client.post(
        "/api/v1/auth/login", json={"email": "teacher@orga.example.com", "password": "pw-teacher-1"}
    )
    assert good.status_code == 200
    tokens = good.json()
    assert tokens["access_token"] and tokens["refresh_token"]

    refreshed = client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.status_code == 200

    bad = client.post(
        "/api/v1/auth/login", json={"email": "teacher@orga.example.com", "password": "wrong"}
    )
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "NOT_AUTHENTICATED"


def test_an_access_token_cannot_be_used_as_a_refresh_token(client, org_with_users):
    tokens = client.post(
        "/api/v1/auth/login", json={"email": "teacher@orga.example.com", "password": "pw-teacher-1"}
    ).json()
    response = client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["access_token"]})
    assert response.status_code == 401


def test_role_matrix():
    assert has_permission(Role.REVIEWER, Permission.READ)
    assert has_permission(Role.REVIEWER, Permission.REVIEW_MAPPING)
    assert not has_permission(Role.REVIEWER, Permission.UPLOAD_DOCUMENT)
    assert has_permission(Role.TEACHER, Permission.UPLOAD_DOCUMENT)
    assert not has_permission(Role.TEACHER, Permission.MANAGE_ORG)
    assert has_permission(Role.ADMIN, Permission.MANAGE_ORG)
    assert has_permission(Role.ADMIN, Permission.UPLOAD_DOCUMENT)


def test_repository_refuses_an_unscoped_query(session):
    repository = AssessmentRepository(session)
    with pytest.raises(AssertionError):
        repository.list("")
