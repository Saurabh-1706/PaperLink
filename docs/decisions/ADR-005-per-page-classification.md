# ADR-005 — Documents are classified per page, not per document

**Status:** Accepted
**Date:** 2026-08-29

## Context

The system must handle searchable PDFs, scanned PDFs and image-based PDFs, choosing
native extraction where text is genuinely present and OCR where it is not.

The straightforward implementation classifies the whole document once on upload.

## Decision

**Classification happens per page.** Each page independently gets `searchable`,
`scanned` or `image`, stored on the `pages` row along with the `extraction_method`
actually used.

```
for each page:
    coverage = native_text_area / page_area
    searchable if coverage > threshold and glyphs map to real fonts
    else scanned
```

## Consequences

**Good**

- A typed question paper with a scanned diagram page is handled correctly, which
  document-level classification cannot do.
- OCR is spent only where it is needed, which matters on long documents.
- `extraction_method` is recorded at the granularity it actually varies, so confidence
  and accuracy can be analysed per page.

**Costs**

- Slightly more work at ingestion, and a mixed document produces heterogeneous
  confidence values that downstream stages must handle. Since OCR pages already carry
  varying confidence, this costs nothing structurally.

## Rejected alternative

*Classify once per document.* Either drops real text on the scanned pages of a mostly
digital PDF, or wastes an OCR pass over pages whose text was already perfect — and in
the first case it fails silently, producing a document that simply appears to have fewer
questions than it does.
