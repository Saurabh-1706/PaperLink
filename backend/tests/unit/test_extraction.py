"""Extraction core: classification, native path, OCR path, reading order, markdown."""
from __future__ import annotations

import io

import pytest

from app.ai.ocr.base import OCRWord
from app.ai.ocr.stub import StubOCREngine
from app.core.errors import UnsupportedFileError
from app.modules.documents.pdf import render_pages
from app.modules.documents.validation import validate_pdf
from app.modules.extraction.markdown import document_to_markdown
from app.modules.extraction.pipeline import extract_document
from app.modules.extraction.preprocess import preprocess_for_ocr
from app.modules.extraction.reading_order import detect_columns, order_boxes
from app.schemas.common import BBox, ExtractionMethod, PageClassification


def test_validation_rejects_non_pdf():
    with pytest.raises(UnsupportedFileError):
        validate_pdf(b"not a pdf at all", declared_mime="application/pdf")


def test_validation_reports_page_count_and_checksum(question_pdf: bytes):
    validated = validate_pdf(question_pdf)
    assert validated.page_count == 2
    assert len(validated.checksum) == 64


def test_searchable_pages_use_the_native_path(question_pdf: bytes):
    output = extract_document(question_pdf, "doc", "question_paper")
    assert [page.classification for page in output.ir.pages] == [
        PageClassification.SEARCHABLE,
        PageClassification.SEARCHABLE,
    ]
    assert all(page.extraction_method == ExtractionMethod.TEXT for page in output.ir.pages)
    assert all(block.confidence == 1.0 for page in output.ir.pages for block in page.blocks)


def test_original_page_dimensions_are_recorded(question_pdf: bytes):
    output = extract_document(question_pdf, "doc", "question_paper")
    page = output.ir.pages[0]
    assert (round(page.width), round(page.height)) == (595, 842)
    assert page.dpi > 0
    assert output.artifacts[0].image_bytes.startswith(b"\x89PNG")


def test_every_bbox_is_inside_the_page(question_pdf: bytes):
    output = extract_document(question_pdf, "doc", "question_paper")
    for page in output.ir.pages:
        for block in page.blocks:
            assert 0.0 <= block.bbox.x1 < block.bbox.x2 <= 1.0
            assert 0.0 <= block.bbox.y1 < block.bbox.y2 <= 1.0


def test_ocr_path_returns_coordinates_in_original_page_space(question_pdf: bytes):
    """A scanned page's OCR boxes must be inverted out of preprocessed space."""
    render = render_pages(question_pdf)[0]
    preprocessed = preprocess_for_ocr(render.image_bytes)

    from PIL import Image

    image = Image.open(io.BytesIO(preprocessed.image_bytes))
    # A word occupying the top-left eighth of the preprocessed image.
    word = OCRWord(
        text="Physics",
        x1=image.width * 0.1,
        y1=image.height * 0.1,
        x2=image.width * 0.4,
        y2=image.height * 0.15,
        confidence=0.9,
    )
    engine = StubOCREngine()
    engine.set_default([word])

    # Force the OCR path by treating the page as scanned.
    from app.modules.extraction import pipeline as extraction_pipeline

    render.classification = PageClassification.SCANNED
    blocks = extraction_pipeline._ocr_blocks(render, engine, handwriting=False)
    assert blocks, "OCR path produced no blocks"
    bbox = blocks[0].bbox
    assert bbox.x1 == pytest.approx(0.1, abs=0.05)
    assert bbox.y1 == pytest.approx(0.1, abs=0.05)


def _skewed_photo_pdf() -> bytes:
    """A PDF whose only page is a perspective-warped photo of a page -- what a
    student's phone photo, wrapped into a PDF with no scanning app involved, looks
    like: no text layer, and the "paper" sits at an angle against a background."""
    cv2 = pytest.importorskip("cv2")
    import numpy as np
    import pymupdf

    canvas = np.zeros((600, 800, 3), dtype=np.uint8)
    page_img = np.ones((400, 300, 3), dtype=np.uint8) * 255
    src = np.array([[0, 0], [299, 0], [299, 399], [0, 399]], dtype=np.float32)
    dst = np.array([[150, 80], [650, 40], [600, 520], [100, 560]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page_img, matrix, (800, 600))
    mask = cv2.warpPerspective(np.ones((400, 300), dtype=np.uint8) * 255, matrix, (800, 600))
    canvas[mask > 0] = warped[mask > 0]
    ok, buf = cv2.imencode(".png", canvas)

    document = pymupdf.open()
    page = document.new_page(width=800, height=600)
    page.insert_image(page.rect, stream=buf.tobytes())
    data = document.tobytes()
    document.close()
    return data


def test_render_pages_auto_rectifies_a_photographed_page():
    """A photographed (non-searchable) page must come out of render_pages already
    flattened -- the coordinate contract downstream assumes a flat rectangular page,
    and there is no scanning app in the loop to guarantee that on its own."""
    from app.core.config import settings

    data = _skewed_photo_pdf()
    original = settings.auto_rectify_photos
    try:
        settings.auto_rectify_photos = False
        without = render_pages(data)[0]
        settings.auto_rectify_photos = True
        with_rectify = render_pages(data)[0]
    finally:
        settings.auto_rectify_photos = original

    assert without.classification != PageClassification.SEARCHABLE
    # Rectification crops to just the detected page region, so the pixel grid
    # differs from the raw, unrectified photo frame.
    assert (with_rectify.image_width, with_rectify.image_height) != (
        without.image_width,
        without.image_height,
    )
    # width/height stay in lockstep with the corrected pixel grid -- there is no
    # vector "points" concept for a photographed page.
    assert with_rectify.width == with_rectify.image_width
    assert with_rectify.height == with_rectify.image_height


def test_low_confidence_blocks_are_flagged_not_dropped(question_pdf: bytes):
    render = render_pages(question_pdf)[0]
    engine = StubOCREngine()
    engine.set_default(
        [OCRWord(text="scribble", x1=10, y1=10, x2=200, y2=60, confidence=0.2)]
    )
    from app.modules.extraction import pipeline as extraction_pipeline

    blocks = extraction_pipeline._ocr_blocks(render, engine, handwriting=True)
    assert len(blocks) == 1
    assert blocks[0].low_confidence is True


def test_reading_order_detects_two_columns():
    left = [BBox(x1=0.05, y1=0.1 + i * 0.1, x2=0.45, y2=0.15 + i * 0.1) for i in range(4)]
    right = [BBox(x1=0.55, y1=0.1 + i * 0.1, x2=0.95, y2=0.15 + i * 0.1) for i in range(4)]
    boxes = [value for pair in zip(left, right) for value in pair]  # interleaved input
    assert len(detect_columns(boxes)) == 2
    order = order_boxes(boxes)
    # The whole left column must precede the whole right column.
    assert order[:4] == [0, 2, 4, 6]


def test_single_column_page_orders_top_to_bottom():
    boxes = [BBox(x1=0.1, y1=0.5, x2=0.9, y2=0.6), BBox(x1=0.1, y1=0.1, x2=0.9, y2=0.2)]
    assert order_boxes(boxes) == [1, 0]


def test_markdown_is_a_rendering_with_page_provenance(question_pdf: bytes):
    output = extract_document(question_pdf, "doc", "question_paper")
    markdown = document_to_markdown(output.ir)
    assert "## Page 1" in markdown
    assert "extraction_method=text" in markdown
    assert "Define velocity" in markdown
