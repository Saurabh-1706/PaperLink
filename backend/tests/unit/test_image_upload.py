"""Uploading photos instead of a PDF: one-or-more JPEG/PNG images (one per page)
must convert into a PDF that the rest of the pipeline (validate_pdf, render_pages)
sees as an ordinary upload -- no downstream code should need to know the difference."""
from __future__ import annotations

import io

import pytest

from app.core.errors import CorruptDocumentError, UnsupportedFileError
from app.modules.documents.pdf import images_to_pdf, render_pages
from app.modules.documents.validation import normalize_upload_to_pdf, validate_pdf


def _jpeg(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="JPEG")
    return buf.getvalue()


def _png(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def test_a_single_pdf_passes_through_unchanged(question_pdf: bytes):
    data, mime = normalize_upload_to_pdf([("q.pdf", question_pdf)])
    assert data == question_pdf
    assert mime == "application/pdf"


def test_a_single_photo_becomes_a_one_page_pdf():
    photo = _jpeg(800, 600, (255, 0, 0))
    data, mime = normalize_upload_to_pdf([("photo.jpg", photo)])
    assert mime == "application/pdf"
    validated = validate_pdf(data)
    assert validated.page_count == 1


def test_multiple_photos_become_one_multi_page_pdf_in_order():
    photos = [
        ("page1.jpg", _jpeg(800, 600, (255, 0, 0))),
        ("page2.png", _png(800, 600, (0, 255, 0))),
        ("page3.jpg", _jpeg(800, 600, (0, 0, 255))),
    ]
    data, mime = normalize_upload_to_pdf(photos)
    validated = validate_pdf(data)
    assert validated.page_count == 3

    renders = render_pages(data)
    assert len(renders) == 3
    # Each page's rendered image samples back the colour of the photo that made it,
    # confirming both page count and page ORDER survived the conversion.
    from PIL import Image

    expected_colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
    for render, expected in zip(renders, expected_colors):
        image = Image.open(io.BytesIO(render.image_bytes)).convert("RGB")
        sampled = image.getpixel((image.width // 2, image.height // 2))
        assert all(abs(a - b) < 30 for a, b in zip(sampled, expected))


def test_a_photo_preserves_its_own_aspect_ratio():
    """A portrait photo must not get squashed into a landscape page or vice versa --
    the page is sized to the image's own dimensions (see images_to_pdf)."""
    photo = _jpeg(600, 1000, (128, 128, 128))  # portrait
    data, _ = normalize_upload_to_pdf([("portrait.jpg", photo)])
    render = render_pages(data)[0]
    assert render.height > render.width


def test_mixed_pdf_and_photo_batch_is_rejected(question_pdf: bytes):
    with pytest.raises(UnsupportedFileError):
        normalize_upload_to_pdf([("q.pdf", question_pdf), ("extra.jpg", _jpeg(100, 100, (0, 0, 0)))])


def test_empty_upload_is_rejected():
    with pytest.raises(UnsupportedFileError):
        normalize_upload_to_pdf([])


def test_unsupported_format_is_rejected():
    with pytest.raises(UnsupportedFileError):
        normalize_upload_to_pdf([("notes.txt", b"just some plain text, not an image")])


def test_corrupt_image_bytes_raise_corrupt_document_not_a_crash():
    garbage = b"\xff\xd8\xff" + b"not actually a valid jpeg body"
    with pytest.raises(CorruptDocumentError):
        normalize_upload_to_pdf([("broken.jpg", garbage)])


def test_images_to_pdf_directly_produces_the_right_page_count():
    data = images_to_pdf([_jpeg(400, 300, (10, 20, 30)), _png(400, 300, (40, 50, 60))])
    assert validate_pdf(data).page_count == 2
