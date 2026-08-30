"""Full upload -> process -> mappings round trip, job lifecycle, idempotency."""
from __future__ import annotations

from tests.conftest import auth_header


def _create_assessment(client, token: str) -> str:
    response = client.post(
        "/api/v1/assessments", json={"title": "Physics 2026"}, headers=auth_header(token)
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _upload(client, token: str, assessment_id: str, route: str, data: bytes) -> dict:
    response = client.post(
        f"/api/v1/assessments/{assessment_id}/{route}",
        files={"files": ("doc.pdf", data, "application/pdf")},
        headers=auth_header(token),
    )
    assert response.status_code == 202, response.text
    return response.json()


def test_end_to_end_upload_process_and_read(client, tokens, question_pdf, answer_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)

    question_doc = _upload(client, token, assessment_id, "question-paper", question_pdf)
    _upload(client, token, assessment_id, "answer-sheet", answer_pdf)
    assert question_doc["page_count"] == 2
    assert question_doc["classification"] == "searchable"

    job = client.post(
        f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token)
    ).json()
    assert job["status"] == "succeeded", job
    assert job["stage"] == "done"
    assert job["progress"] == 1.0

    questions = client.get(
        f"/api/v1/assessments/{assessment_id}/questions", headers=auth_header(token)
    ).json()
    numbers = [question["display_number"] for question in questions]
    assert numbers == ["1", "2", "3", "4", "5", "11 (a)", "11 (b)", "12"]
    assert all(question["regions"] for question in questions)

    answers = client.get(
        f"/api/v1/assessments/{assessment_id}/answers", headers=auth_header(token)
    ).json()
    assert len(answers) >= 7
    continuation = [answer for answer in answers if answer["is_continuation_of"]]
    assert continuation, "the two-page answer must be linked"

    mappings = client.get(
        f"/api/v1/assessments/{assessment_id}/mappings", headers=auth_header(token)
    ).json()
    direct = [m for m in mappings if m["mapping_type"] == "direct"]
    assert len(direct) >= 6
    assert all(m["evidence"] for m in mappings)
    # Every mapped answer carries the regions the UI highlights.
    assert all(m["regions"] for m in direct)

    results = client.get(
        f"/api/v1/assessments/{assessment_id}/results", headers=auth_header(token)
    ).json()
    assert results["mapping_count"] == len(mappings)
    assert results["unanswered"] >= 1


def test_grades_are_readable_per_mapping(client, tokens, question_pdf, answer_pdf):
    """`results` aggregates; the review UI needs the mark against its own mapping."""
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    _upload(client, token, assessment_id, "question-paper", question_pdf)
    _upload(client, token, assessment_id, "answer-sheet", answer_pdf)
    client.post(f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token))

    mappings = client.get(
        f"/api/v1/assessments/{assessment_id}/mappings", headers=auth_header(token)
    ).json()
    grades = client.get(
        f"/api/v1/assessments/{assessment_id}/grades", headers=auth_header(token)
    ).json()

    assert grades, "a processed assessment has graded mappings"
    mapping_ids = {mapping["id"] for mapping in mappings}
    assert all(grade["mapping_id"] in mapping_ids for grade in grades)
    assert all(grade["max_score"] >= grade["score"] >= 0 for grade in grades)

    results = client.get(
        f"/api/v1/assessments/{assessment_id}/results", headers=auth_header(token)
    ).json()
    assert results["total_score"] == round(sum(grade["score"] for grade in grades), 2)


def test_multi_page_answer_mapping_carries_every_region(client, tokens, question_pdf, answer_pdf):
    """The two-page answer must reach the UI as one mapping with a region per page."""
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    _upload(client, token, assessment_id, "question-paper", question_pdf)
    _upload(client, token, assessment_id, "answer-sheet", answer_pdf)
    client.post(f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token))

    mappings = client.get(
        f"/api/v1/assessments/{assessment_id}/mappings", headers=auth_header(token)
    ).json()
    spans = [m for m in mappings if len({r["page"] for r in m["regions"]}) > 1]
    assert len(spans) == 1
    assert sorted(r["page"] for r in spans[0]["regions"]) == [1, 2]


def test_job_progress_is_reported_per_stage(client, tokens, question_pdf, answer_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    _upload(client, token, assessment_id, "question-paper", question_pdf)
    _upload(client, token, assessment_id, "answer-sheet", answer_pdf)
    job = client.post(
        f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token)
    ).json()

    polled = client.get(
        f"/api/v1/assessments/{assessment_id}/jobs/{job['job_id']}", headers=auth_header(token)
    ).json()
    assert polled["job_id"] == job["job_id"]
    assert polled["error"] is None


def test_processing_without_documents_records_a_typed_job_error(client, tokens):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    job = client.post(
        f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token)
    ).json()
    assert job["status"] == "failed"
    assert job["error"].startswith("NOT_FOUND")


def test_uploads_dedupe_by_checksum(client, tokens, question_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    first = _upload(client, token, assessment_id, "question-paper", question_pdf)
    second = _upload(client, token, assessment_id, "question-paper", question_pdf)
    assert first["created"] is True
    assert second["created"] is False
    assert first["document_id"] == second["document_id"]


def test_remap_reruns_mapping_only(client, tokens, question_pdf, answer_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    _upload(client, token, assessment_id, "question-paper", question_pdf)
    _upload(client, token, assessment_id, "answer-sheet", answer_pdf)
    client.post(f"/api/v1/assessments/{assessment_id}/process", headers=auth_header(token))

    before = client.get(
        f"/api/v1/assessments/{assessment_id}/answers", headers=auth_header(token)
    ).json()
    job = client.post(
        f"/api/v1/assessments/{assessment_id}/remap", headers=auth_header(token)
    ).json()
    assert job["status"] == "succeeded"
    after = client.get(
        f"/api/v1/assessments/{assessment_id}/answers", headers=auth_header(token)
    ).json()
    assert [a["id"] for a in before] == [a["id"] for a in after]


def test_page_image_route_serves_the_rendered_page(client, tokens, question_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    document = _upload(client, token, assessment_id, "question-paper", question_pdf)
    response = client.get(
        f"/api/v1/documents/{document['document_id']}/pages/1/image", headers=auth_header(token)
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")


def test_markdown_is_available_but_is_only_a_rendering(client, tokens, question_pdf):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    document = _upload(client, token, assessment_id, "question-paper", question_pdf)
    response = client.get(
        f"/api/v1/documents/{document['document_id']}/markdown", headers=auth_header(token)
    )
    assert response.status_code == 200
    assert "## Page 1" in response.text


def test_error_envelope_is_uniform(client, tokens):
    response = client.get("/api/v1/assessments/does-not-exist", headers=auth_header(tokens["teacher"]))
    assert response.status_code == 404
    body = response.json()
    assert set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == "NOT_FOUND"


def test_upload_rejects_a_non_pdf(client, tokens):
    token = tokens["teacher"]
    assessment_id = _create_assessment(client, token)
    response = client.post(
        f"/api/v1/assessments/{assessment_id}/question-paper",
        files={"files": ("evil.pdf", b"MZ not a pdf", "application/pdf")},
        headers=auth_header(token),
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_FILE"


def test_health_needs_no_token(client):
    assert client.get("/health").json()["status"] == "ok"
