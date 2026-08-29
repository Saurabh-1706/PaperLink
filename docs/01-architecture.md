# Architecture

**Status:** Reference

## Layers

```
FastAPI  (auth/RBAC, assessments, documents, pipeline triggers)
   │
   ├─ Deterministic core — plain Python, NO LangGraph
   │     ingestion → page render → native text | OCR → normalize → IR → Markdown + JSON
   │
   └─ Pipeline Service → LangGraph graphs (state, retry, confidence routing)
         ├─ question_graph     ├─ answer_graph     └─ mapping_graph
         (LangChain used only inside nodes: LLM calls, structured output, embeddings)
                                    ↓
                             Grading engine
```

## The deterministic core

These stay ordinary Python services. They are pure, fast, testable without a network,
and they are where coordinates come from:

- PDF → page images
- PyMuPDF native text extraction
- Image preprocessing
- OCR invocation
- Bounding-box math
- Markdown generation
- Database CRUD

Wrapping any of these in an agent framework would add state machinery to code that has
no state, and would make the coordinate path harder to reason about. See
[ADR-002](decisions/ADR-002-langgraph-scope.md).

## Where LangGraph earns its place

Only where there is genuine state, branching, retry or confidence-based routing:

```
Upload → Classify PDF
   ├─ native text available → Extract
   └─ failed → OCR
        ↓
     Normalize → Validate → Question Extraction → Confidence Check
        ├─ High → Continue
        └─ Low  → Vision/LLM validation
```

Three graphs, each independently runnable: `question_graph`, `answer_graph`,
`mapping_graph`.

## Where LangChain earns its place

Inside graph nodes only — LLM calls, structured output parsing, prompt templates,
embeddings, model abstraction. Never as the orchestration layer.

## Model strategy

Hybrid, never one model for everything:

| Task | Tool |
|---|---|
| Searchable PDF text | PyMuPDF |
| Scanned PDF OCR | PaddleOCR (docTR adapter available) |
| Bounding boxes | OCR / layout engine — **always** |
| Handwriting interpretation | Vision LLM *validating* OCR output |
| Question structure normalisation | LLM with structured JSON output |
| Question ↔ Answer mapping | Custom engine: deterministic + embeddings + LLM validation |
| Grading | Deterministic rules + LLM rubric scoring |
| Workflow | LangGraph |
| LLM utilities | LangChain |

## Provider interfaces

Business logic imports an ABC, never a vendor module. Provider selection is config.

```
OCREngine              → PaddleOCREngine, DocTREngine
DocumentVisionProvider → GeminiProvider, OpenAIProvider
LLMProvider            → GeminiProvider, OpenAIProvider
EmbeddingProvider      → (config-selected)
StorageBackend         → GridFSStorage, LocalStorage
```

See [ADR-004](decisions/ADR-004-provider-interfaces.md).

## Module independence

`question_pipeline`, `answer_pipeline` and `mapping_engine` each take IR-JSON in and
structured JSON out. All three are unit-testable from fixtures with **zero database,
zero network, zero LLM**. This is the property that makes the accuracy work tractable.

## Repository layout

```
backend/app/
├── main.py
├── api/v1/        auth, assessments, documents, questions, answers, mappings, results, health
├── core/          config, security, permissions, errors, logging
├── db/            base (documents), session (Mongo + unit of work), models/, repositories/
├── schemas/       pydantic contracts shared across layers
├── modules/       auth, assessments, documents, extraction, question_pipeline,
│                  answer_pipeline, mapping_engine, grading, feedback
├── ai/            ocr/, llm/, prompts/, evaluators/
├── graphs/        question_graph, answer_graph, mapping_graph, state
├── workers/       celery_app, tasks
└── storage/       base, gridfs, local

frontend/
├── app/           Next.js App Router
├── components/ui/ shadcn primitives
├── features/      upload, questions, answers, mapping, assessment
├── services/      typed API client
└── lib/           bbox transforms, hooks, auth
```

## Cross-cutting contracts

- Every stage declares a pydantic **input schema, output schema, confidence semantics
  and failure mode**. A stage that cannot proceed writes a typed error to `jobs.error`;
  it never returns a silently empty result.
- Every LLM call uses structured output against a JSON schema, versioned prompts in
  `ai/prompts/`, logged token counts, and a deterministic fallback on failure or invalid
  JSON. **No pipeline may require an LLM to produce a result.**
