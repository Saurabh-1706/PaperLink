# ADR-002 — LangGraph orchestrates only stateful, branching work

**Status:** Accepted
**Date:** 2026-08-29

## Context

LangGraph is the orchestration layer for this system, and there is a natural pull toward
expressing the whole pipeline as a graph for uniformity.

## Decision

LangGraph is used **only** where there is genuine state, branching, retry, or
confidence-based routing:

- Question extraction workflow
- Answer extraction workflow
- Mapping workflow
- Retry and fallback logic
- Confidence-based routing
- Human-review state
- Error recovery

The following remain **ordinary Python services**:

- PDF to images
- PyMuPDF extraction
- OCR invocation
- Image preprocessing
- Bounding-box calculation
- Markdown generation
- Database CRUD

LangChain is used inside graph nodes only — LLM calls, structured output, prompt
templates, embeddings, model abstraction — never as the orchestration layer.

## Consequences

**Good**

- The coordinate path stays plain, fast and debuggable with a stack trace.
- The deterministic core is testable with no framework and no network.
- The core document/OCR pipeline stays framework-independent and could outlive a change
  of orchestration library.

**Costs**

- Two idioms in one codebase; the boundary must be understood and respected.
- Some cross-cutting concerns (tracing, retries) are implemented twice.

## Rejected alternative

*Model everything as agent workflows.* Rejected because it turns simple, deterministic
processing into state machines, makes debugging a bbox bug an exercise in graph
inspection, and couples the most stable part of the system to the least stable dependency.
