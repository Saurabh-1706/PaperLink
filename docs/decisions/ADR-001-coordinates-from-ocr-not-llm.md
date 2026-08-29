# ADR-001 — Coordinates come from OCR/layout, never from an LLM

**Status:** Accepted
**Date:** 2026-08-29

## Context

The headline requirement is exact answer-region highlighting: the grader must see
precisely where on the original sheet an answer sits. Modern vision models understand
documents well and can be asked to return bounding boxes directly, which is tempting
because it collapses several pipeline stages into one call.

## Decision

**Bounding boxes are produced exclusively by the deterministic extraction layer** —
PyMuPDF for native text, the OCR engine for scanned pages. A vision model may reason
*about* regions the pipeline produced, receiving and returning **block ids**, but it
never emits numbers that become a coordinate.

For example, OCR produces:

```
"11(a)"            -> bbox
"Explain..."       -> bbox
handwritten answer -> bbox
```

and the vision model is then asked only to reason: *these regions belong to answer
11(a), which continues onto page 4.*

## Consequences

**Good**

- Coordinates are reproducible, cheap, and independent of model version or temperature.
- A model upgrade cannot silently shift every highlight in the system.
- Coordinate correctness is unit-testable without a network.
- The system degrades gracefully: if the LLM is unavailable, highlighting still works.

**Costs**

- More pipeline stages to build and maintain than a single vision call.
- OCR quality becomes a hard floor on region quality.
- Preprocessing transforms must be tracked and inverted, which is fiddly and is the main
  remaining source of coordinate bugs — mitigated by the Phase 3 visual regression check.

## Rejected alternative

*Ask the vision model for boxes directly.* Rejected because model-emitted coordinates
drift between versions, cannot be verified without the model, and fail in the worst
possible way — plausible-looking numbers that put the highlight in the wrong place while
the text and confidence both look fine.
