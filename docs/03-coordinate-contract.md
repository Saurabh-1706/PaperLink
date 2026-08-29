# The Coordinate Contract

**Status:** Reference — **read this before touching any coordinate**

Exact region highlighting is the headline requirement. Coordinates are therefore the
most safety-critical data in the system, and they get one convention, enforced everywhere.

## The convention

```
bbox := [x1, y1, x2, y2]
```

- **Normalised floats in `[0, 1]`** — not pixels, not points.
- **Origin top-left**, y increasing downward.
- **Relative to the page's original dimensions**, as recorded in `pages.width` /
  `pages.height`.
- `x1 < x2` and `y1 < y2` always; degenerate boxes are a validation failure, not a
  value to store.

## Why normalised

The same box must be correct against a 300-DPI render in the backend, a downscaled
thumbnail in the UI, and a browser canvas at whatever width the layout gives it.
Normalised coordinates survive every one of those resizes; pixel coordinates survive
none of them without carrying their reference frame around.

## Ownership

Exactly two places convert coordinates:

| Side | File | Responsibility |
|---|---|---|
| Backend | `app/modules/extraction/ir.py` | Pixel/point → normalised, and inverse |
| Frontend | `frontend/lib/bbox.ts` | Normalised → rendered pixel rect |

Nothing else does coordinate math. A third conversion site is how these systems drift.

## Rule 1 — Coordinates never come from an LLM

A vision model reasons *about* regions the OCR pipeline already produced. It receives
block ids and returns block ids. It never returns numbers that become a bbox.

See [ADR-001](decisions/ADR-001-coordinates-from-ocr-not-llm.md).

## Rule 2 — Preprocessing transforms must be invertible

The OCR path deskews, denoises and rescales the page image before recognition. OCR
therefore returns coordinates in **preprocessed space**, which is not page space.

Every preprocessing step records its transform, and the pipeline inverts the composed
transform before storing anything:

```
original page ──T──> preprocessed image ──OCR──> bbox in preprocessed space
                                                        │
                                                     T⁻¹ │
                                                        ▼
                                              bbox in original page space  ← what is stored
```

**Storing a preprocessed-space coordinate is the single most likely cause of a
highlight landing in the wrong place.** It fails quietly: the text is right, the
confidence is high, and the box is simply somewhere else. The Phase 3 visual
regression check exists specifically to catch this.

## Rule 3 — Original page dimensions are never lost

`pages.width`, `pages.height` and `pages.dpi` are captured at render time and are
immutable afterwards. They are the reference frame that makes a normalised box
meaningful.

## Rule 4 — Multi-region is the default shape

Regions are always a list, even when there is one. A question or answer spanning pages
3 and 4 is not a special case to be bolted on later:

```json
{
  "answer_id": "...",
  "regions": [
    {"page": 3, "bbox": [0.12, 0.61, 0.88, 0.94]},
    {"page": 4, "bbox": [0.12, 0.08, 0.88, 0.37]}
  ]
}
```

## Validation

Enforced on write:

- `0 ≤ x1 < x2 ≤ 1` and `0 ≤ y1 < y2 ≤ 1`
- `page_number` exists in `pages` for the owning document
- Region area is above a minimum threshold (guards against OCR noise fragments)

## Verifying it works

The Phase 3 debug script draws stored regions back onto rendered page images. The
overlay must land on the text it claims. This is cheap, visual, and catches the entire
class of transform bugs that unit tests on numbers do not.
