# CLAUDE.md

AI Assessment Extraction & Answer Mapping — backend. Docs in `docs/` are the spec
(`docs/03-coordinate-contract.md` is binding). This file is the short version.

## Architecture

```
backend/app/
  api/v1/     FastAPI routes (thin: validate, enqueue, read)
  core/       config, logging, errors, security, permissions
  db/         base (entities), models/, repositories/ (all org-scoped), session (UoW)
  schemas/    pydantic contracts between every layer
  modules/    auth, assessments, documents, extraction, question_pipeline,
              answer_pipeline, mapping_engine, grading  (pure Python, no framework)
  ai/         ocr/, llm/, prompts/, evaluators/   (ABCs + adapters, config-selected)
  graphs/     question_graph, answer_graph, mapping_graph (LangGraph only)
  workers/    celery_app, tasks
  storage/    base, gridfs, local
```

## Commands

```bash
cd backend
pytest                       # unit + integration
pytest tests/eval            # accuracy scorecard
uvicorn app.main:app --reload
python -c "from app.db.session import create_all; create_all()"   # indexes
```

## Coding rules

- Deterministic Python first. LangGraph only for stateful/branching/confidence routing.
  LangChain only inside graph nodes (LLM calls, structured output).
- Every module boundary uses a pydantic schema in `app/schemas/`. No dicts across layers.
- No pipeline may *require* an LLM to produce a result; every AI step has a
  deterministic fallback.
- Heavy/optional deps (PyMuPDF, PaddleOCR, cv2, provider SDKs) are imported lazily
  inside adapters, never at module import time.
- Repositories take `organization_id` as a required argument; the base class asserts the
  query carries the org filter before it reaches Mongo.
- Persistence is MongoDB: entities are dataclasses, the Unit of Work (`app/db/session.py`)
  owns every driver call, and binaries (PDFs, page images, IR-JSON, markdown) go to GridFS.
  There is no schema migration step — only index declarations.

## Pipeline rules

- `bbox = [x1,y1,x2,y2]`, normalised floats in [0,1], origin top-left, relative to the
  page's ORIGINAL dimensions. Conversion happens only in `modules/extraction/ir.py`.
- Preprocessing transforms are recorded and inverted before any bbox is stored.
- Regions are always a list (multi-page is the default shape, not a special case).
- Markdown is a rendering, never parsed back. IR-JSON is authoritative.
- Question / answer / mapping / grading are independent modules: IR-JSON in,
  structured JSON out, testable with no DB, no network, no LLM.
- Low-confidence blocks are flagged, never dropped.

## Model usage rules

- Coordinates never come from an LLM. Vision models take block ids, return block ids.
- LLM is called only in the ambiguous confidence band (mapping stage 5, question
  ambiguity routing, handwriting validation). Skip the call when the margin is decisive.
- No embeddings unless a stage's score is genuinely undecided; keyword overlap first.
- Providers behind ABCs in `app/ai/`; selection is config (`LLM_PROVIDER`, `OCR_ENGINE`).

## Constraints

- Cross-tenant access returns 404, never 403 — storage reads included.
- Real rollback requires a replica set (`MONGO_TRANSACTIONS=true`); on standalone mongod
  only unflushed writes are discarded, so writes are idempotent and flushed late.
- `needs_review` mappings never score. They may carry a `provisional` grade so a
  teacher sees a starting point, but it is excluded from `graded_count`,
  `total_score` and `percentage` until a human confirms the mapping.
- Processing is async (Celery); handlers enqueue and read only.
- Uniform error envelope: `{"error": {"code", "message", "details"}}`.
