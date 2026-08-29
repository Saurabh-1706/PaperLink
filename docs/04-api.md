# API Contract

**Status:** Implemented (Phase 9)
**Module:** `app/api/v1/`

All processing is **asynchronous** via Celery + Redis. HTTP handlers only enqueue and
read — a large scanned PDF must never block a request.

## Routes

```
POST  /auth/login                          -> access + refresh tokens
POST  /auth/refresh

POST  /assessments                         -> assessment
POST  /assessments/{id}/question-paper     -> 202 + job_id
POST  /assessments/{id}/answer-sheet       -> 202 + job_id
POST  /assessments/{id}/process            -> 202 + job_id
POST  /assessments/{id}/remap              -> 202 + job_id   (re-runs mapping only)

GET   /assessments/{id}/questions
GET   /assessments/{id}/answers
GET   /assessments/{id}/mappings           ?review_status=
GET   /assessments/{id}/results
GET   /assessments/{id}/jobs/{job_id}      -> stage, status, progress, error

GET   /documents/{id}/pages/{n}/image      -> tenant-checked page image
PATCH /mappings/{id}                       -> reviewer correction

GET   /health
```

## Why `remap` is separate from `process`

Mapping is the stage most likely to need re-running after a threshold change or a
reviewer correction. Re-running it must not force re-OCR of a 40-page scan.

## Job model

Uploads and processing return `202 Accepted` with a `job_id`. The client polls:

```json
{
  "job_id": "...",
  "stage": "answer_extraction",
  "status": "running",
  "progress": 0.62,
  "error": null
}
```

`stage` is per-pipeline-stage, not a single opaque percentage, so the UI can show what
is actually happening during a slow OCR pass.

## Error envelope

Uniform across all routes:

```json
{
  "error": {
    "code": "ENCRYPTED_PDF",
    "message": "The uploaded PDF is password protected.",
    "details": {"document_id": "..."}
  }
}
```

Typed codes, not free text — the frontend branches on `code`.

## Idempotency

Uploads dedupe by checksum. Re-uploading an identical file returns the existing document
rather than creating a duplicate and re-running OCR.

## Tenancy

Every route resolves `organization_id` from the token via the `TenantScope` dependency.
Cross-tenant access returns **404, not 403** — a 403 confirms the resource exists. See
[05-rbac.md](05-rbac.md).

The page-image route is included in this rule: raw document images are as sensitive as
the extracted data.
