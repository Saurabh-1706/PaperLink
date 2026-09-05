# CLAUDE.md

AI Assessment Extraction & Answer Mapping. Docs in `docs/` are the spec
(`docs/03-coordinate-contract.md` is binding). This file is the short version.

## Architecture

Unified Next.js full-stack application under `apps/web/`:

```
apps/web/
  app/
    api/auth/     Auth routes: login, logout, refresh, session
    api/backend/  Catch-all route ([...path]) dispatching to internal endpoint handlers
    (pages)       Next.js App Router UI pages and layouts
  features/       Frontend domain features (review, assessment, canvas, upload, etc.)
  components/     Shared React UI components
  lib/
    server/
      ai/         Gemini client, breaker, rate limiter, cascade, structuring, correction
      api/        Internal route dispatcher, DTOs, endpoint handlers (matching API surface)
      auth/       JWT (jose), password hashing (@node-rs/argon2), cookie helpers
      config.ts   Environment configuration and schema validation
      db/         MongoClient, session (Unit of Work), org-scoped repositories, indexes
      graphs/     question_graph, answer_graph, mapping_graph (deterministic state graphs)
      modules/    Domain modules:
                  - extraction: Document -> Page -> Block IR extraction
                  - question_pipeline: Question extraction & label parsing
                  - answer_pipeline: Answer region extraction & vision analysis
                  - mapping_engine: Question-to-answer similarity & assignment
                  - grading: Score calculation & rubric evaluation
                  - assessments: Orchestration, background processing, job states
                  - documents: Document upload, validation & metadata
      storage/    GridFS binary storage (PDFs, page images, JSON artifacts)
    client/       Client utilities, API fetchers
  types/          TypeScript contracts, DTOs, backend schemas
```

## Commands

```bash
npm run dev                  # Start Next.js dev server (runs apps/web on localhost:3000)
npm run test                 # Run unit tests via Vitest
npm run lint                 # Next.js ESLint
npm run build                # Next.js production build
npm run db:indexes           # Ensure MongoDB collections & indexes
npm run seed                 # Seed demo user & organization
```

## Coding rules

- Deterministic TypeScript first. State graphs for stateful/branching/confidence routing.
- Every module boundary uses a TypeScript type/interface and Zod schema in `types/` or `dto.ts`. No untyped dicts/objects across layers.
- No pipeline may *require* an LLM to produce a result; every AI step has a deterministic fallback.
- Heavy/optional deps (pdfjs-dist, @napi-rs/canvas) are imported and isolated cleanly.
- Repositories take `organization_id` as a required argument; queries assert org filter before reaching Mongo.
- Persistence is MongoDB: entities are typed objects, the Unit of Work (`lib/server/db/session.ts`) owns driver sessions/transactions, and binaries (PDFs, page images, IR-JSON, markdown) go to GridFS. There is no schema migration step — only index declarations (`npm run db:indexes`).

## Pipeline rules

- `bbox = [x1,y1,x2,y2]`, normalised floats in [0,1], origin top-left, relative to the
  page's ORIGINAL dimensions. Conversion happens only in `modules/extraction/ir.ts`.
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
- Providers behind adapters in `lib/server/ai/`; selection is config (`GEMINI_MODEL_CASCADE`).

## Constraints

- Cross-tenant access returns 404, never 403 — storage reads included.
- Real rollback requires a replica set (e.g. MongoDB Atlas); on standalone mongod
  only unflushed writes are discarded, so writes are idempotent and flushed late.
- `needs_review` mappings never score. They may carry a `provisional` grade so a
  teacher sees a starting point, but it is excluded from `graded_count`,
  `total_score` and `percentage` until a human confirms the mapping.
- Processing is async job-based; handlers dispatch jobs and poll `JobDto`.
- Uniform error envelope: `{"error": {"code", "message", "details"}}`.
