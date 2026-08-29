# Grading & Feedback

**Status:** Implemented (Phase 7)
**Module:** `app/modules/grading/`, `app/modules/feedback/`

A separate engine — grading is not the job of the mapping engine, and mapping quality
must be measurable independently of scoring quality.

## Order of operations

1. **Deterministic rules first**
   - Blank / `unanswered` produces 0
   - Rubric keyword coverage where the rubric is expressible as terms
2. **LLM rubric scoring** for open-ended answers, with structured JSON output

## The review gate

**A mapping in `needs_review` is never graded.** Scoring an answer that may belong to a
different question produces a confidently wrong mark, which is worse than an unscored
one. It is held for the reviewer.

## Feedback

- Per-answer commentary
- Assessment-level summary

## Inputs and outputs

```
in:  mapping (question, answer, confidence, review_status), rubric
out: score, max_score, rubric breakdown, feedback text
```

Stored in `grades`, keyed by `mapping_id`.
