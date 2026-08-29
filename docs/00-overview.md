# Overview

**Status:** Reference

## The problem

Teachers grade scanned answer sheets against a question paper by hand. Two documents
arrive — a question paper (possibly digital, possibly a scan) and an answer sheet
(almost always handwritten). Someone must read both, work out which piece of writing
answers which question, and score it.

## What the system does

Ingests both documents, extracts structured questions and handwritten answers **with
page-accurate coordinates**, decides which answer belongs to which question, and shows
the grader the exact region on the original page.

```
Question Paper Upload → Validation → Classification → Text/OCR Extraction
   → Markdown + Bounding Boxes → Question Extraction → Question DB
Answer Sheet Upload → OCR/Handwriting → Segmentation + Bounding Boxes → Answer DB
   → Mapping Engine → Grading / Feedback → UI: Question ↔ Answer + Exact Highlight
```

## Success criterion

For any question, the UI can answer four things:

1. **What was asked?**
2. **Which answer belongs to it?**
3. **Where exactly is that answer on the original sheet?**
4. **How confident are we?**

Question 3 is what makes this hard, and it constrains the entire architecture — see
[ADR-001](decisions/ADR-001-coordinates-from-ocr-not-llm.md).

## What the system is judged on

Accuracy of **answer mapping** and **exact region highlighting** — not on how much LLM
it uses. The design consistently prefers a deterministic path, and reaches for a model
only where determinism genuinely runs out.

## Non-goals (for this iteration)

- DOCX and standalone image ingestion — the ingestion layer is designed to accept them
  later, but only PDF variants are supported now.
- Multi-assessment batch grading across a whole class.
- Fine-tuned or self-hosted handwriting models.

## Input support

| Input | Path |
|---|---|
| Searchable / text PDF | Native extraction (PyMuPDF) |
| Scanned PDF | Render → preprocess → OCR |
| Image-based / non-searchable PDF | Render → preprocess → OCR |

Per page, the system always preserves: `document_id`, `page_number`, the original page
image, extracted text, bounding boxes, confidence, extraction method (`text` / `ocr`),
and the original page dimensions. **Page coordinates and original page boundaries are
never lost.**

## Confirmed decisions

| Decision | Choice |
|---|---|
| Scope | Full spec, delivered in phases |
| Vision/LLM provider | Gemini default, behind a swappable interface |
| Local runtime | Docker Compose (MongoDB + GridFS, Redis, worker, OCR) |
| Frontend | Next.js + Tailwind + shadcn, built to the described flow |
