# Answer Mapping Engine

**Status:** Implemented (Phase 6) — **the core deliverable**
**Module:** `app/modules/mapping_engine/`, graph in `app/graphs/mapping_graph.py`

A dedicated module. **Generic LLM prompting is not responsible for mapping.** Each stage
can be disabled independently so its contribution is measurable.

## The stages

```
Stage 1  Explicit label match     detected_label vs normalized_number  -> direct   (0.95-0.99)
Stage 2  Spatial + page analysis  reading order, page sequence, flow   -> spatial  (0.60-0.85)
Stage 3  Candidate generation     top-K questions per unassigned answer
Stage 4  Semantic similarity      embeddings + keyword overlap
Stage 5  LLM validation           ONLY within the ambiguous band
Stage 6  Confidence + assignment  global one-to-one resolution
Stage 7  Final states             unmatched / unanswered / needs_review
```

## Stage 1 — Explicit labels

Where a student wrote `11(a)`, that is near-certain evidence and costs nothing. Label
normalisation is shared with the question pipeline so `11 a`, `11(a)` and `Q11a` collapse
identically.

## Stage 2 — The spatial prior

Most sheets are near-ordered. A candidate scores higher when it preserves monotonic
question order relative to already-confident neighbours.

**This is what rescues unlabelled answers.** Semantic similarity alone is weak on short
handwritten text — a two-line answer often shares little vocabulary with its question —
while position is highly informative and free.

## Stage 4 — Semantic similarity

Embeddings over `normalized_text` against question text, plus keyword overlap. A
contributing signal, not the decision.

## Stage 5 — LLM validation, bounded

If the top-1 score is decisively above the runner-up, **the LLM is not called at all**.
Otherwise it receives the question text and 2-3 candidate answer texts and is asked which
fits. A bounded, cheap, auditable call — not an open-ended "map these for me" prompt.

## Stage 6 — Global assignment, not greedy

Stages 1-5 build a question-by-answer score matrix. It is solved **once**, with
`scipy.optimize.linear_sum_assignment` and a rejection threshold.

Greedy per-answer matching lets one strong local match steal an answer that another
question needed — and this is where mapping accuracy is usually lost. Global assignment
optimises the whole sheet. Multi-region answers are a single column; continuation
segments are merged before the solve. See
[ADR-003](../decisions/ADR-003-global-assignment-for-mapping.md).

## Stage 7 — Outcome states

| Situation | Result |
|---|---|
| Question with no assigned answer | `unanswered` |
| Answer assigned to nothing | `unmatched` — surfaced in the UI as "extra answer" |
| Confidence below the review threshold | `needs_review` — **never silently accepted** |

Confidence thresholds and human-review states exist precisely so uncertain mappings are
not presented as facts.

## The evidence payload

Every mapping records which stage fired, the score breakdown, and the LLM verdict if any.
This is what makes a low-confidence mapping *reviewable* rather than merely doubtful — a
reviewer can see it was a spatial inference with a weak semantic second place, and judge
accordingly.

## Output

```json
{
  "question_id": "...",
  "answer_id": "...",
  "mapping_type": "direct",
  "confidence": 0.94,
  "regions": [{"page": 3, "bbox": [0.12, 0.61, 0.88, 0.94]}]
}
```

## Exit criteria

- Mapping accuracy on the eval set is reported **per `mapping_type`**
- No mapping below threshold is auto-accepted
