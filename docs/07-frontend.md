# Frontend

**Status:** Planned (Phase 10)
**Stack:** Next.js (App Router) + Tailwind + shadcn/ui

> **Note.** The Figma file is not available to this build. The UI is built to the
> described flow and interaction model, not to the design's pixels. See the open
> questions in [PROGRESS.md](PROGRESS.md).

## The experience

```
Upload Question Paper
Upload Answer Sheet
        |
Processing Progress
        |
Question List
        |
Selected Question
        |
Mapped Answer
        |
Original Answer Sheet Page
        |
Exact Answer Region Highlight
```

## Structure

```
app/                  App Router pages
components/ui/        shadcn primitives
features/
  upload/             file drop, validation feedback, job progress
  questions/          question list, selection, numbering display
  answers/            answer text, raw vs normalised
  mapping/            PageCanvas, region navigation, confidence surfacing
  assessment/         assessment shell, results
services/             typed API client
lib/                  bbox.ts, hooks, auth
```

## Highlight rendering

`features/mapping/PageCanvas.tsx` renders `/documents/{id}/pages/{n}/image` and overlays
absolutely-positioned rectangles computed from normalised bboxes multiplied by the
rendered size.

**`lib/bbox.ts` is the only place the frontend does coordinate math**, and it implements
the same convention as the backend. See
[03-coordinate-contract.md](03-coordinate-contract.md).

## Navigation behaviour

- Selecting a question **auto-navigates** to the page of its answer's first region
- Multi-page answers show a region pager ("region 1 of 3")
- **Every** region on the current page is highlighted, not just the active one
- Moving between questions preserves zoom/scroll where sensible

## Surfacing uncertainty

The UI must not present an uncertain mapping as a fact:

| State | Treatment |
|---|---|
| Confidence | Badge on every mapping |
| `mapping_type` | Chip (`direct` / `semantic` / `spatial`) |
| `needs_review` | Visually distinct, filterable, with confirm/correct actions |
| `unanswered` | Explicit state — the question is shown as unanswered |
| `unmatched` | Explicit state — shown as an extra answer |

`unanswered` and `unmatched` get real UI states rather than being hidden. Hiding them
would make the system look more accurate than it is and would leave a grader unaware
that a student wrote something nobody scored.

## Reviewer flow

A Reviewer filters to `needs_review`, inspects the answer against the highlighted region
and the `evidence` breakdown, then confirms or corrects. Correction writes
`human_corrected` via `PATCH /mappings/{id}`.
