# Evaluation Framework

**Status:** Implemented (Phase 8)
**Location:** `backend/tests/eval/`, `app/ai/evaluators/`

Accuracy is the point of this system, so it is measured rather than asserted. This
framework is also the tuning loop for every confidence threshold in Phases 4-6 — the
thresholds are chosen from these numbers, not guessed.

## Metrics

| Metric | Definition |
|---|---|
| Question extraction accuracy | Precision / recall / F1 on question text spans |
| Question number accuracy | Exact match on `display_number` |
| Answer extraction accuracy | Precision / recall / F1 on answer segments |
| Answer mapping accuracy | Correct (question, answer) pairs / total, **reported per `mapping_type`** |
| Bounding box accuracy | Mean IoU, plus percentage above 0.7 |
| Unanswered detection accuracy | Precision / recall on genuinely blank questions |
| Multi-page answer accuracy | Percentage of multi-page answers with **all** regions recovered |

## Why per-`mapping_type` reporting

An aggregate mapping number hides the thing that matters. `direct` matches on labelled
sheets are easy and will always score well; `spatial` and `semantic` matches on
unlabelled sheets are where the engine earns its keep. Reporting them separately is what
makes a regression visible instead of averaged away.

## Fixtures

`tests/fixtures/` holds documents with hand-annotated ground-truth JSON. The set must
include the awkward cases, since those are the ones the design claims to handle:

- A mixed searchable/scanned PDF
- A paper using `11(a)` / `11(b)` and `(i)` / `(ii)`
- An answer sheet with an out-of-order answer
- A two-page answer with a continuation
- A genuinely blank (unanswered) question
- An extra answer that maps to nothing
- An optional-question section

## Running

```bash
make eval          # pytest tests/eval -s
```

The scorecard runs on generated fixtures (`tests/fixtures/generator.py`) so the ground
truth and the document can never drift apart, and it runs with **no LLM at all** — the
deterministic path alone must produce every number.

Prints a scorecard for all seven metrics. Thresholds are committed to the repo and
enforced as a regression test — a metric that drops fails the build.

## Relationship to unit tests

Unit tests assert behaviour is *correct*. The eval suite asserts accuracy has not
*degraded*. Both are needed: a refactor can keep every unit test green while quietly
costing five points of mapping accuracy.
