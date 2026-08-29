# ADR-004 — All models sit behind swappable interfaces

**Status:** Accepted
**Date:** 2026-08-29

## Context

The system depends on an OCR engine, a vision/document model, a text LLM, an embedding
model and a storage backend. Each of these is a fast-moving choice, and the right one
cannot be known before the evaluation suite exists to compare them.

## Decision

Business logic imports an abstract base class, never a vendor module. Selection is
configuration.

```
OCREngine              -> PaddleOCREngine, DocTREngine
DocumentVisionProvider -> GeminiProvider, OpenAIProvider
LLMProvider            -> GeminiProvider, OpenAIProvider
EmbeddingProvider      -> (config-selected)
StorageBackend         -> LocalStorage, S3Storage
```

Gemini is the default vision/document provider, chosen for native PDF understanding
including scanned documents. OpenAI is implemented as a peer, not a fallback, so the two
can be benchmarked against the eval suite without touching pipeline code.

## Consequences

**Good**

- Providers can be compared on real metrics rather than reputation.
- A provider outage or price change is a config edit.
- Tests substitute fakes at the interface, so pipelines test with no network.

**Costs**

- An abstraction layer over APIs that differ in real ways; the interface must be kept
  narrow enough that it does not leak provider-specific concepts.
- Provider-specific capabilities are either normalised away or accessed through an escape
  hatch that weakens the abstraction.

## Related

Storage containerisation follows the same reasoning: all services run in Docker Compose
locally so that native PaddleOCR and PyMuPDF installs on Windows are never on the
critical path.
