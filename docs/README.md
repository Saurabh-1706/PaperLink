# Documentation Index

Living documentation for the **AI Assessment Extraction & Answer Mapping** system.
Every document here is expected to be updated as the code changes — if a doc and the
code disagree, the doc is a bug.

## Start here

| Doc | What it answers |
|---|---|
| [00-overview.md](00-overview.md) | What is this system, what problem does it solve, how is it judged |
| [PROGRESS.md](PROGRESS.md) | **Phase-by-phase build tracker — current status lives here** |
| [01-architecture.md](01-architecture.md) | How the pieces fit; what is deterministic vs orchestrated |
| [02-data-model.md](02-data-model.md) | MongoDB collections, GridFS, entities, relationships |
| [03-coordinate-contract.md](03-coordinate-contract.md) | The bbox convention — read before touching any coordinate |

## Subsystems

| Doc | What it answers |
|---|---|
| [pipelines/extraction.md](pipelines/extraction.md) | Ingestion, classification, native text, OCR, the IR |
| [pipelines/question-pipeline.md](pipelines/question-pipeline.md) | How questions and their numbering are recovered |
| [pipelines/answer-pipeline.md](pipelines/answer-pipeline.md) | How handwritten answers are segmented and linked |
| [pipelines/mapping-engine.md](pipelines/mapping-engine.md) | The core deliverable: question ↔ answer mapping |
| [pipelines/grading.md](pipelines/grading.md) | Scoring and feedback generation |

## Interfaces & operations

| Doc | What it answers |
|---|---|
| [04-api.md](04-api.md) | HTTP contract, async job model, error envelope |
| [05-rbac.md](05-rbac.md) | Organizations, roles, tenant isolation rules |
| [06-evaluation.md](06-evaluation.md) | Accuracy metrics, fixtures, regression thresholds |
| [07-frontend.md](07-frontend.md) | UI flow, highlight rendering, review states |
| [08-deployment.md](08-deployment.md) | Local dev, Docker, migrations, configuration |
| [09-testing.md](09-testing.md) | Test layers and how to run each |

## Decisions

Architecture Decision Records live in [decisions/](decisions/). Each records a choice
that was expensive to make and would be expensive to reverse.

| ADR | Decision |
|---|---|
| [ADR-001](decisions/ADR-001-coordinates-from-ocr-not-llm.md) | Coordinates come from OCR/layout, never from an LLM |
| [ADR-002](decisions/ADR-002-langgraph-scope.md) | LangGraph orchestrates only stateful/branching work |
| [ADR-003](decisions/ADR-003-global-assignment-for-mapping.md) | Mapping uses global assignment, not greedy matching |
| [ADR-004](decisions/ADR-004-provider-interfaces.md) | All models sit behind swappable interfaces |
| [ADR-005](decisions/ADR-005-per-page-classification.md) | Documents are classified per page, not per document |

## Conventions for these docs

- **Status lines.** Each subsystem doc opens with a status line (`Planned` / `In progress` / `Implemented`) so a reader knows whether it describes reality or intent.
- **Schemas are copied, not summarised.** If a doc shows a JSON shape, it is the real shape.
- **No duplication of code.** Docs explain *why* and *what contract*; code is the source of truth for *how*.
