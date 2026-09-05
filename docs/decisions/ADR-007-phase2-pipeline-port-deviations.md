# ADR-007: Question/answer extraction, mapping and grading — Next.js port deviations

**Status:** Accepted (Next.js/Vercel migration, Phase 2)

## Context

Phase 2 ports `question_pipeline`, `answer_pipeline`, `mapping_engine`, `grading`,
and the three graphs that wrap them, from the deleted Python backend into
`apps/web/lib/server/**`. Most of the port is a faithful, regex-for-regex,
threshold-for-threshold translation. Three places deliberately depart from the
Python source's literal behavior.

## Decisions

### 1. Graphs are plain functions, not a LangGraph dependency

ADR-002 reserves `graphs/` for LangGraph specifically ("only where there is genuine
state, branching, retry or confidence-based routing"). `question_graph.py`,
`answer_graph.py` and `mapping_graph.py` are each 2-3 nodes with exactly one
conditional branch and no cycles or retries — the graph library added no behavior
over a hand-written `if`/`await`, at the cost of a new runtime dependency
(`@langchain/langgraph` + `@langchain/core`) for a Next.js app with no other
LangChain usage. `apps/web/lib/server/graphs/*.ts` reproduce the exact same node
sequence and routing conditions as plain async functions instead. This narrows
ADR-002's "LangGraph only" rule to "graph-shaped control flow only, not
necessarily the library" — if a future stage introduces real cycles, retries, or
multi-step state that a hand-written function stops being the clearer
representation of, that is the point to actually add the dependency.

### 2. `process`/`remap` run synchronously in the request, not on a queue

The Python system's default was `CELERY_TASK_ALWAYS_EAGER=true` — synchronous
execution was already the common case, not the exception. The Next.js backend has
no Redis/Celery (removed with the rest of the Python stack), and document
upload/OCR already runs its own AI pipeline synchronously inside the request
(`modules/documents/service.ts::ingest`). `process`/`remap` follow the same
pattern: the whole pipeline (question/answer extraction → mapping → grading) runs
inside the POST handler before it responds.

A `Job` row is still written and advanced stage-by-stage
(`modules/assessments/processing.ts`), matching the wire contract
(`types/backend.ts::JobDto`) the frontend's poll loop already expects. But because
every write inside one `process()` call shares a single MongoDB transaction
(`db/session.ts`), a concurrent `GET /jobs/:id` poll only ever observes the job
before the attempt started or after it committed — never mid-flight. The
frontend's progressive per-stage UI collapses into one wait for the duration of the
call; nothing in its polling *logic* needed to change, since an already-terminal
initial response is a valid (if unexciting) input to that loop.

### 3. `/results` uses the *filtered* score aggregation, not the Python endpoint's literal behavior

CLAUDE.md states a binding invariant: "`needs_review` mappings never score... They
may carry a provisional grade so a teacher sees a starting point, but it is
excluded from `graded_count`, `total_score` and `percentage` until a human confirms
the mapping." `grading/engine.py` implements this correctly in its own
`assessment_summary()` — but the actual live `/results` route
(`AssessmentService.results()` in `assessments/service.py`) never called it; it
summed every grade's `score`/`max_score` regardless of `method`, including
`provisional` and `skipped` ones. That is a bug against the project's own
documented contract, not an intentional relaxation of it (see `9630942`, which
fixed the same bug in `assessment_summary()` itself but never reached the route
that actually serves `/results`).

`api/dto.ts::resultsOut` computes `mapping_count`/`needs_review`/`unanswered`/
`unmatched` the same way the Python route did (straight from the mapping rows), but
`total_score`/`max_score`/`percentage` come from
`modules/grading/engine.ts::assessmentSummary()` — the filtered aggregation. This
is a correctness fix, not a stylistic port choice.

## Consequences

- No new runtime dependencies for graph orchestration.
- No new job-queue infrastructure; the tradeoff is a single long-running request
  (already anticipated by the API route's `maxDuration = 300` and the frontend's
  10-minute poll timeout) instead of a live progress bar during processing.
- A `needs_review` mapping's provisional grade can no longer leak into a student's
  reported score or percentage, closing the gap between documented and actual
  behavior.
