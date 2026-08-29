# Extraction Pipeline (deterministic core)

**Status:** Implemented (Phase 2–3)
**Module:** `app/modules/documents/`, `app/modules/extraction/`

Turns an uploaded file into the Intermediate Representation. Contains no LLM calls and
no LangGraph — it is pure Python and is where every coordinate in the system originates.

## Stage 1 — Validation

- MIME sniff **and** magic-byte check (never trust the declared content type)
- Page-count and file-size caps
- Encrypted PDF rejection with a typed error
- Checksum dedupe → re-uploading the same file is idempotent

## Stage 2 — Classification, per page

A PDF can mix searchable and scanned pages — a typed paper with a scanned diagram page
is common. Classifying the whole document would either drop text or waste OCR on pages
that already have it. See [ADR-005](../decisions/ADR-005-per-page-classification.md).

```
for each page:
    native_text = pymupdf.extract(page)
    coverage    = text_area / page_area
    if coverage > threshold and glyphs map to real fonts:
        classification = searchable   → native path
    else:
        classification = scanned      → OCR path
```

## Stage 3 — Rendering

Every page renders to PNG at a normalised DPI (300 default, with a long-edge downscale
cap), stored via `StorageBackend`. Original `width`, `height` and `dpi` are recorded at
this moment and never change.

Pages are rendered **even when searchable**, because the UI highlights against a page
image regardless of how the text was obtained.

## Stage 4a — Native text path

PyMuPDF word/line/block extraction with bboxes.

```
extraction_method = "text"
confidence        = 1.0
```

## Stage 4b — OCR path

```
grayscale → deskew → denoise → adaptive contrast → resolution normalise → OCR
```

Each preprocessing step **records its transform**. The composed transform is inverted
before any coordinate is stored — see
[the coordinate contract](../03-coordinate-contract.md#rule-2--preprocessing-transforms-must-be-invertible).

OCR sits behind `OCREngine`:

```python
class OCREngine(ABC):
    @abstractmethod
    def run(self, image: Image) -> list[Block]: ...
```

PaddleOCR is the default; docTR is an adapter behind the same interface.

## Stage 5 — The Intermediate Representation

The single source of truth for everything downstream:

```
Document
 └── Page(number, width, height, dpi, extraction_method)
      └── Block(text, bbox, confidence, block_type, reading_order)
```

Both pipelines consume IR-JSON and nothing else. That is what lets them be tested with
no database, no network and no models.

## Stage 6 — Reading order

Column detection first, then top-to-bottom and left-to-right within each column. A
naive pure-y sort interleaves the columns of a two-column paper and silently destroys
question boundaries.

## Stage 7 — Two serialisations, one source

| Output | Purpose | Authoritative for |
|---|---|---|
| `.md` | Human-readable content | Nothing |
| IR-JSON | Machine consumption | **Coordinates, pages, confidence, blocks, relationships** |

**Markdown is never parsed back.** It is a rendering, not a data format. Round-tripping
through Markdown is exactly how coordinates get lost.

## Low-confidence handling

Blocks below the confidence threshold are **flagged, not dropped**, and become
candidates for vision-LLM re-reading in the answer pipeline. Dropping them loses
handwriting; silently keeping them at face value loses accuracy.

## Exit criteria

- Golden-file tests assert IR-JSON block counts, text and bboxes for fixture PDFs
  within tolerance
- A bbox drawn back onto its rendered page visually lands on its text
