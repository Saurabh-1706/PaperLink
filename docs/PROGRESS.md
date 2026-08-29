# Build Progress Tracker

Single source of truth for **where the build currently stands**. Update the status
column in the same commit that changes the code — a stale tracker is worse than none.

Status values: `Not started` · `In progress` · `Done` · `Blocked` · `Cut`

---

## Phase status

| # | Phase | Status | Exit criterion |
|---|---|---|---|
| 0 | Foundations (Docker, FastAPI skeleton, tooling) | Done | `docker compose up` serves `/health`; `pytest` green |
| 1 | Auth, RBAC, tenancy | Done | Cross-tenant test: org B gets 404 on every org A route |
| 2 | Ingestion & page rendering | Done | Mixed searchable/scanned PDF → per-page classification + rendered images + original dims |
| 3 | Extraction & normalisation (IR) | Done | Golden IR-JSON matches fixtures; bboxes land on their text |
| 4 | Question pipeline | Done | Question count, order and `display_number` match ground truth |
| 5 | Answer pipeline | Done | Out-of-order + two-page + blank fixture produces expected segments |
| 6 | **Mapping engine** | Done | Mapping accuracy reported per `mapping_type`; nothing below threshold auto-accepted |
| 7 | Grading & feedback | Done | Rubric scoring runs; `needs_review` mappings are never auto-graded |
| 8 | Evaluation framework | Done | `make eval` prints all seven metrics; thresholds enforced in CI |
| 9 | API layer | Done | All routes async via Celery; job progress observable |
| 10 | Frontend | Owned by the UI workstream | Question → answer → exact highlight works end to end |
| 11 | Deployment | In progress | Reproducible build + seeded demo |

**Sequencing rule.** Phases 2→6 are the graded core and are built and measured before
any UI work. If time runs short, cut Phase 7 (grading depth) and Phase 11 (deployment
polish) — never Phase 8, which is the only thing that substantiates accuracy claims.

---

## Phase 0 — Foundations

- [x] `docker-compose.yml` — mongo (replica set), redis, api, worker
- [x] `Dockerfile.api` / `Dockerfile.worker` with PyMuPDF, PaddleOCR, poppler
- [x] FastAPI app skeleton + `/health`
- [x] Settings via pydantic-settings, `.env.example`
- [x] Structured logging with `request_id` + `assessment_id`
- [x] Index declarations (`create_all()`); MongoDB has no schema migration
- [x] pytest / ruff / mypy wired, `make test`
- [x] Documentation tree (this folder)

## Phase 1 — Auth, RBAC, tenancy

- [x] Organization + User documents, argon2 hashing
- [x] JWT access + refresh
- [x] `require_role()` dependency
- [x] `TenantScope` dependency
- [x] Org-scoped repository base that refuses unscoped queries
- [x] Cross-tenant isolation integration suite

## Phase 2 — Ingestion & page rendering

- [x] File validation (MIME sniff, magic bytes, size/page caps, encrypted PDF reject)
- [x] Checksum dedupe
- [x] Per-page classification (`searchable` / `scanned` / `image`)
- [x] Page rendering at normalised DPI, original dimensions recorded
- [x] `StorageBackend` interface + `GridFSStorage` / `LocalStorage`

## Phase 3 — Extraction & normalisation

- [x] Native text extraction (PyMuPDF) with bboxes
- [x] Image preprocessing (deskew, denoise, contrast, resolution) with invertible transform
- [x] `OCREngine` interface + PaddleOCR adapter (+ deterministic stub for tests)
- [x] Intermediate Representation (Document → Page → Block)
- [x] Reading-order assignment (column detection)
- [x] Markdown serialiser + authoritative IR-JSON
- [x] Low-confidence block flagging

## Phase 4 — Question pipeline

- [x] Numbering regex family + label normalisation
- [x] Hierarchy build (`11(a)`, `(i)`, parent links)
- [x] Body assignment + multi-page question regions
- [x] `question_graph` ambiguity routing
- [x] Optional-question detection
- [x] Marks detection

## Phase 5 — Answer pipeline

- [x] Handwriting OCR path
- [x] Answer segmentation (labels, whitespace, geometry, ink density)
- [x] Continuation detection across pages
- [x] Vision-LLM transcription validation for low-confidence regions
- [x] Text normalisation (`raw_text` preserved)

## Phase 6 — Mapping engine

- [x] Stage 1 — explicit label match
- [x] Stage 2 — spatial + page analysis
- [x] Stage 3 — candidate generation
- [x] Stage 4 — semantic similarity
- [x] Stage 5 — LLM validation (ambiguous band only)
- [x] Stage 6 — global assignment (Hungarian)
- [x] Stage 7 — outcome states + `needs_review`
- [x] `evidence` payload for reviewability

## Phase 7 — Grading & feedback

- [x] Deterministic rules (blank → 0, rubric coverage)
- [x] LLM rubric scoring with structured output
- [x] Review gate (no grading of `needs_review`)
- [x] Per-answer + assessment-level feedback

## Phase 8 — Evaluation

- [x] Labelled fixture set
- [x] Seven metric implementations
- [x] `make eval` scorecard
- [x] Committed regression thresholds

## Phase 9 — API

- [x] Auth routes
- [x] Assessment + upload routes (202 + job_id)
- [x] Read routes (questions, answers, mappings, results)
- [x] Job status route
- [x] Tenant-checked page image route
- [x] Reviewer correction route
- [x] Uniform error envelope

## Phase 10 — Frontend

- [ ] Upload flow + processing progress
- [ ] Question list + selection
- [ ] Mapped answer panel
- [ ] `PageCanvas` highlight overlay
- [ ] Multi-region / multi-page navigation
- [ ] Confidence + `mapping_type` surfacing
- [ ] `unanswered` / `unmatched` states
- [ ] Reviewer confirm/correct

## Phase 11 — Deployment

- [ ] Multi-stage images
- [ ] `docker-compose.prod.yml`
- [ ] Migrations on release
- [ ] Seeded demo org
- [ ] README demo script

---

## Open questions

| Question | Owner | Status |
|---|---|---|
| Datastore switched from Postgres to MongoDB + GridFS mid-build | User | Resolved — docs 02/08 updated |
| Figma file not available — frontend built to described flow, not pixels | User | Open |
| Sample question paper + answer sheet needed for the fixture set | User | Open — generated fixtures used meanwhile (`tests/fixtures/generator.py`) |
| Gemini API credentials for the vision provider | User | Open |

## Risk log

| Risk | Impact | Mitigation |
|---|---|---|
| Handwriting OCR quality drives everything downstream | High | Vision-LLM transcription validation on low-confidence regions; confidence surfaced, never hidden |
| Preprocessing transforms corrupt bbox coordinates | High | Transform recorded and inverted; visual bbox regression check in Phase 3 |
| Mapping degenerates on unlabelled sheets | High | Spatial monotonicity prior + global assignment rather than semantic-only |
| PaddleOCR native install on Windows | Medium | All services containerised; a deterministic stub engine keeps the suite runnable natively |
| LLM latency/cost on large PDFs | Medium | LLM only in the ambiguous band; deterministic path always sufficient to produce a result |


---

## Current state (backend)

- `pytest` — 102 tests green (unit, integration, eval).
- Deterministic path produces every eval metric with **no LLM configured**; the Gemini
  provider is wired behind `LLMProvider` / `DocumentVisionProvider` and is exercised in
  tests through recording fakes.
- OCR runs behind `OCREngine`; PaddleOCR is the deployed adapter, and a deterministic
  stub keeps the suite hermetic where the engine is not installed.
- Outstanding for Phase 11: production compose file, release automation, and a scripted
  demo beyond `make seed`.
