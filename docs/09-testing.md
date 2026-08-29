# Testing Strategy

**Status:** Implemented (unit, integration and eval suites green)

Four layers, each answering a different question.

## Unit — `tests/unit/`

*Is this component correct?* No database, no network, no models.

- Bounding-box math and transform inversion
- Label normalisation (`11 a` / `11(a)` / `Q11a` collapse identically)
- Question hierarchy building
- Each mapping stage in isolation
- Segmentation heuristics

This layer is possible because `question_pipeline`, `answer_pipeline` and
`mapping_engine` all take IR-JSON in and structured JSON out.

## Integration — `tests/integration/`

*Do the pieces work together?* In-memory MongoDB (`mongomock`), inline task execution, mocked providers.

- Full upload -> process -> mappings round trip
- Job lifecycle and progress reporting
- **Cross-tenant isolation across every route** (org B gets 404 on org A resources)
- Error envelope correctness for each typed failure

## Evaluation — `tests/eval/`

*Has accuracy degraded?* See [06-evaluation.md](06-evaluation.md). Runs against labelled
fixtures with committed thresholds.

## Visual — the region debug script

`python -m app.scripts.draw_regions <document_id> --org <organization_id>`

*Do the boxes land on the text?* Draws stored regions back onto rendered page images.

Cheap, visual, and the only practical way to catch a coordinate-space bug — those fail
silently with correct text and high confidence, so no assertion on numbers alone will
find them.

## Running

```bash
make test          # unit + integration
make eval          # accuracy scorecard
make lint          # ruff + mypy
```

## Fixtures

`tests/fixtures/` holds real documents with hand-annotated ground truth, deliberately
weighted toward the awkward cases the design claims to handle. See
[06-evaluation.md](06-evaluation.md#fixtures).
