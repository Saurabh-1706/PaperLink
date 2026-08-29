"""PDF access: per-page classification, rendering, and native word extraction.

PyMuPDF is imported lazily inside functions so the package remains importable in
environments without it. This module never converts coordinates — it reports raw
point/pixel geometry plus the page dimensions, and `extraction/ir.py` normalises.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.core.config import settings
from app.schemas.common import PageClassification


@dataclass(frozen=True)
class NativeWord:
    text: str
    x1: float
    y1: float
    x2: float
    y2: float
    block_no: int
    line_no: int


@dataclass
class PageRender:
    page_number: int
    width: float           # original page width, in points
    height: float          # original page height, in points
    dpi: int
    image_bytes: bytes
    image_width: int
    image_height: int
    classification: PageClassification
    native_words: list[NativeWord] = field(default_factory=list)


def _open(data: bytes):
    import pymupdf

    return pymupdf.open(stream=data, filetype="pdf")


def classify_page(page, threshold: float | None = None) -> PageClassification:
    """Per-page classification (ADR-005): text coverage decides the extraction path."""
    threshold = settings.searchable_coverage_threshold if threshold is None else threshold
    page_area = float(page.rect.width * page.rect.height)
    if page_area <= 0:
        return PageClassification.IMAGE
    text_area = 0.0
    has_text = False
    for word in page.get_text("words"):
        x1, y1, x2, y2, text = word[0], word[1], word[2], word[3], word[4]
        if not str(text).strip():
            continue
        has_text = True
        text_area += max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if not has_text:
        # No glyphs at all: an image-only page if it carries images, otherwise a blank scan.
        return PageClassification.IMAGE if page.get_images(full=True) else PageClassification.SCANNED
    return (
        PageClassification.SEARCHABLE
        if text_area / page_area > threshold
        else PageClassification.SCANNED
    )


def render_pages(data: bytes, dpi: int | None = None) -> list[PageRender]:
    """Render every page and classify it. Pages are rendered even when searchable,
    because the UI highlights against a page image regardless of extraction method."""
    dpi = dpi or settings.render_dpi
    document = _open(data)
    renders: list[PageRender] = []
    try:
        for index in range(document.page_count):
            page = document[index]
            classification = classify_page(page)
            zoom = dpi / 72.0
            long_edge_px = max(page.rect.width, page.rect.height) * zoom
            if long_edge_px > settings.render_max_long_edge:
                zoom *= settings.render_max_long_edge / long_edge_px
            import pymupdf

            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            words = _native_words(page)
            renders.append(
                PageRender(
                    page_number=index + 1,
                    width=float(page.rect.width),
                    height=float(page.rect.height),
                    dpi=int(round(72.0 * zoom)),
                    image_bytes=pixmap.tobytes("png"),
                    image_width=pixmap.width,
                    image_height=pixmap.height,
                    classification=classification,
                    native_words=words,
                )
            )
    finally:
        document.close()
    return renders


def _native_words(page) -> list[NativeWord]:
    """Native words in DISPLAY space — the same frame as `page.rect` and the pixmap.

    PyMuPDF reports text geometry in the page's UNROTATED space, while `page.rect` and
    `get_pixmap()` are both post-rotation. On a `/Rotate 90` scan the two frames are
    transposed, so normalising a raw word box against `page.rect` puts the highlight on
    a different part of the page entirely (and can push a coordinate out of [0,1], where
    clamping hides it). `page.rotation_matrix` is the map between the two frames; it is
    the identity when the page is not rotated.
    """
    import pymupdf

    matrix = page.rotation_matrix
    out: list[NativeWord] = []
    for w in page.get_text("words"):
        if not str(w[4]).strip():
            continue
        box = pymupdf.Rect(w[0], w[1], w[2], w[3]) * matrix
        box.normalize()
        out.append(
            NativeWord(
                text=str(w[4]),
                x1=float(box.x0), y1=float(box.y0), x2=float(box.x1), y2=float(box.y1),
                block_no=int(w[5]), line_no=int(w[6]),
            )
        )
    return out


def group_words_into_lines(words: list[NativeWord]) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Group native words into lines using PyMuPDF's own block/line indices."""
    buckets: dict[tuple[int, int], list[NativeWord]] = {}
    for word in words:
        buckets.setdefault((word.block_no, word.line_no), []).append(word)
    lines: list[tuple[str, tuple[float, float, float, float]]] = []
    for key in sorted(buckets):
        group = sorted(buckets[key], key=lambda w: w.x1)
        text = " ".join(w.text for w in group).strip()
        if not text:
            continue
        box = (
            min(w.x1 for w in group),
            min(w.y1 for w in group),
            max(w.x2 for w in group),
            max(w.y2 for w in group),
        )
        lines.append((text, box))
    return lines
