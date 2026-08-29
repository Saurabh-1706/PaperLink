# Question Pipeline

**Status:** Implemented (Phase 4)
**Module:** `app/modules/question_pipeline/`, graph in `app/graphs/question_graph.py`

Independent module. Input: IR-JSON. Output: structured questions with regions.
Deterministic parsing first; LLM reasoning **only** where structure is genuinely ambiguous.

## Requirements

- Preserve original numbering exactly (`1`, `2`, `10`, …)
- `11(a)` and `11(b)` are **separate questions**
- Support nested parts (`(i)`, `(ii)`)
- Preserve printed order
- Detect questions spanning multiple pages
- Preserve question bounding boxes and page references
- Detect optional / unanswered question areas where possible

## Stage 1 — Numbering detection

A regex family runs over blocks in reading order:

```
1.    1)    Q1    Q.1    10.
11(a)    11 (a)    11a
(i)    (ii)    a)    (b)
```

Each match records the block, its bbox, and the detected nesting level.

## Stage 2 — Hierarchy

`11(a)` and `11(b)` become separate question rows sharing `parent_id` of `11`;
`(i)`/`(ii)` nest one level deeper.

| Field | Purpose |
|---|---|
| `display_number` | The paper's rendering, preserved verbatim — `"11 (a)"` stays `"11 (a)"` |
| `normalized_number` | Sortable canonical form — `11.a.i` |

The split matters: `display_number` is what a human recognises on the page,
`normalized_number` is what the mapping engine matches against. Conflating them means
either the UI shows something the paper doesn't, or matching fails on whitespace.

Label normalisation is **shared with the mapping engine** so `11 a`, `11(a)` and `Q11a`
all collapse identically.

## Stage 3 — Body assignment

Blocks between number *n* and number *n+1* in reading order belong to *n*. A question
crossing a page boundary accumulates a region on each page:

```json
{"pages": [2, 3], "regions": [
  {"page": 2, "bbox": [...]},
  {"page": 3, "bbox": [...]}
]}
```

## Stage 4 — Ambiguity routing (`question_graph`)

Deterministic checks decide whether a model is needed at all:

- **Monotonicity** — do detected numbers increase?
- **Gap detection** — is 7 missing between 6 and 8?
- **Orphan blocks** — text belonging to no question

Only failing regions reach the vision LLM. It returns structure referencing **block
ids**, never coordinates; the pipeline resolves ids back to stored bboxes.

## Stage 5 — Optional questions

"Attempt any 5", "Answer either (a) or (b)" → `optional = true`. Without this, every
deliberately-skipped question in an optional section reads as a missing answer and
pollutes the unanswered-detection metric.

## Stage 6 — Marks

`[5 marks]`, `(10)` captured into `max_marks` when present, for grading.

## Output

```json
{
  "question_id": "...",
  "display_number": "11(a)",
  "normalized_number": "11.a",
  "parent_id": "...",
  "text": "...",
  "pages": [2],
  "regions": [{"page": 2, "bbox": [0.1, 0.22, 0.9, 0.31]}],
  "order_index": 14,
  "optional": false,
  "max_marks": 5,
  "confidence": 0.97
}
```

## Exit criteria

Question count, ordering and `display_number` strings match labelled ground truth on
the fixture set.
