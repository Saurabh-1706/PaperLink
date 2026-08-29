# ADR-003 — Mapping uses global assignment, not greedy matching

**Status:** Accepted
**Date:** 2026-08-29

## Context

The mapping engine scores question/answer candidate pairs across several stages: label
match, spatial position, semantic similarity, and LLM validation. Something must turn
those scores into final assignments.

The obvious approach is greedy: for each answer, take the highest-scoring question.

## Decision

Stages 1-5 build a **question-by-answer score matrix**, solved **once** with
`scipy.optimize.linear_sum_assignment` (Hungarian) plus a rejection threshold for pairs
too weak to assign at all.

Multi-region answers occupy a single column. Continuation segments are merged before the
solve, so a two-page answer competes as one candidate.

## Consequences

**Good**

- One strong local match cannot steal an answer that another question needed more. This
  is the failure mode where greedy matching loses most of its accuracy.
- The whole sheet is optimised jointly, which suits the near-ordered structure of real
  answer sheets.
- The rejection threshold gives `unmatched` and `unanswered` a principled definition
  rather than a leftover one.

**Costs**

- Requires scipy and a dense matrix; irrelevant at the scale of one assessment.
- Slightly harder to explain to a reviewer than "best match wins" — mitigated by the
  `evidence` payload recording the score breakdown per pair.
- One-to-one assignment must be relaxed deliberately if a future requirement allows one
  answer to serve several questions.

## Rejected alternative

*Greedy per-answer argmax.* Simpler and faster, but systematically mis-assigns whenever
two questions have similar text and one answer is a strong match for both — precisely
the ambiguous cases the engine exists to get right.
