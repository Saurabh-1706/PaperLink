# Answer Pipeline

**Status:** Implemented (Phase 5)
**Module:** `app/modules/answer_pipeline/`, graph in `app/graphs/answer_graph.py`

**Structurally independent of the question pipeline** — different module, different
graph, no shared state beyond the IR. They are deliberately not allowed to know about
each other; that relationship is the job of the mapping engine alone.

## What it must handle

| Case | Handling |
|---|---|
| Handwritten answers | Handwriting-tuned OCR + vision-LLM transcription validation |
| Answers spanning multiple pages | Continuation detection produces multiple regions on one answer |
| Answers written out of order | Segmentation makes no order assumption; mapping resolves it |
| Unanswered questions | Produces no segment; surfaces as `unanswered` at mapping time |
| Extra answers that map to nothing | Kept and surfaced as `unmatched` — never discarded |
| Continuation pages | `is_continuation_of` link |
| Multiple regions for one answer | The default shape, not a special case |

## Stage 1 — OCR

Every answer-sheet page goes through the OCR path with handwriting-tuned configuration.
Native text extraction only if the sheet is genuinely digital.

## Stage 2 — Segmentation

Answer candidates are found using four independent signals:

1. **Explicit label detection** — `11(a)`, `Ans 3`, `Q.5`
2. **Vertical whitespace gaps** — the strongest signal on unlabelled sheets
3. **Ruled-line and margin geometry**
4. **Ink-density and size shifts**

No single signal is reliable alone: labels are often absent, whitespace is inconsistent
in handwriting, and margins vary by sheet.

## Stage 3 — Continuation detection

A segment that begins a page with **no label**, directly below a segment that ran to the
bottom of the previous page, links via `is_continuation_of` and contributes an additional
region to the same logical answer. Explicit cues (`contd.`, `P.T.O.`) raise confidence in
the link.

Continuations are merged **before** the assignment step of the mapping engine, so a
two-page answer competes as one candidate rather than two.

## Stage 4 — Vision-LLM validation

For low-confidence handwriting regions only: the cropped region image plus the OCR text
go to the vision model, which returns **corrected transcription only**.

**Coordinates are untouched by this stage.** The model improves what the text says, never
where it is.

## Stage 5 — Normalisation

- `raw_text` — preserved verbatim, exactly as OCR produced it
- `normalized_text` — whitespace, ligature and unicode cleanup, used for similarity

Both are kept. `raw_text` is what a human reviewer needs when checking a doubtful
transcription; `normalized_text` is what embeddings should consume.

## Output

```json
{
  "answer_id": "...",
  "raw_text": "...",
  "normalized_text": "...",
  "detected_label": "11(a)",
  "page_numbers": [3, 4],
  "regions": [
    {"page": 3, "bbox": [0.12, 0.61, 0.88, 0.94]},
    {"page": 4, "bbox": [0.12, 0.08, 0.88, 0.37]}
  ],
  "confidence": 0.83,
  "extraction_method": "ocr"
}
```

## Exit criteria

A fixture sheet containing an out-of-order answer, a two-page answer and a blank
question produces the expected answer count and region sets.
