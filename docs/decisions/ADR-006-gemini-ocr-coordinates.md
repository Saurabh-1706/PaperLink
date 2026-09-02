# ADR-006: Gemini is the OCR engine of record for scanned/handwritten pages

**Status:** Accepted (Next.js/Vercel migration, Phase 1)

## Context

ADR-001 established that coordinates never come from an LLM: a vision model receives
block ids and returns block ids, while a local, deterministic OCR engine (PaddleOCR,
with a docTR/RapidOCR adapter available) was the only source of bounding boxes.

The backend is moving from Python/FastAPI to a Next.js app deployable on Vercel.
PaddleOCR and its alternatives are heavy native/Python dependencies with no
serverless-compatible equivalent, and the migration's brief is explicitly to use the
Gemini API for OCR, with an ordered model-cascade fallback on rate limits (see the
migration plan). Once the local OCR engine is gone, there is no non-LLM source of
bounding boxes left for a scanned or handwritten page.

## Decision

Narrow ADR-001 instead of preserving it verbatim:

- **Native-text PDF pages** (`classification: "searchable"`): unchanged. Bounding
  boxes come from `pdfjs-dist`'s text-content transforms, computed deterministically —
  no model call, no LLM involvement of any kind.
- **Scanned/handwritten pages** (`classification: "scanned"`): Gemini vision is now
  the OCR engine of record. One call per page (`lib/server/ai/ocr.ts`) returns every
  line's text, bounding box, confidence, and printed/handwritten classification in a
  single structured JSON response.

The discipline the rest of the coordinate contract (docs/03-coordinate-contract.md)
establishes is unchanged: every returned box is validated and normalised through
`lib/server/modules/extraction/geometry.ts` — the same single conversion site as
before — before it is stored; low-confidence blocks are flagged (`lowConfidence`),
never dropped; regions are still page-anchored lists.

## Consequences

- A vision model's own mistakes can now land a bounding box in the wrong place, where
  before that class of bug was structurally impossible for OCR pages. Mitigation is
  the same tool the rest of this codebase already uses for LLM output: validate
  (`validateBbox` rejects degenerate/out-of-range boxes), flag low confidence rather
  than trust it blindly, and keep the discipline that a wrong answer here costs
  extraction quality, not silent corruption (a rejected box is dropped, not stored
  askew).
- No pipeline may *require* an LLM to produce a result (CLAUDE.md) still holds for the
  native-text path unconditionally. For the OCR path it now means: if the entire
  Gemini model cascade fails or is cooling down, the page still gets a rendered image
  and an explicit, flagged empty block (`lib/server/modules/extraction/pipeline.ts`)
  rather than a crash or a silently missing page — there is no deterministic OCR
  fallback left to produce real text, which is the one place this migration accepts a
  strictly weaker guarantee than the Python backend had.
- The old two-stage design (cheap local OCR, then a selective vision-LLM pass to
  correct only the low-confidence lines) collapses into a single Gemini call per page.
  Running a second Gemini pass to "correct" Gemini's own first pass would be
  circular, so it is not done.
