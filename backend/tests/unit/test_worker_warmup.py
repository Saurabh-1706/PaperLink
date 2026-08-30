"""Phase 2: worker warm-up and the vision compression memo.

Neither test requires ONNX, RapidOCR or a broker — the factory is monkeypatched and
the memo is exercised on an in-memory PNG.
"""
from __future__ import annotations

import io

import pytest

from app.core.errors import ProviderUnavailableError
from app.modules.answer_pipeline import vision
from app.workers import celery_app as celery_module


class _RecordingEngine:
    name = "recording"

    def __init__(self) -> None:
        self.runs: list[bytes] = []

    def run(self, image_bytes: bytes) -> list:
        self.runs.append(image_bytes)
        return []


@pytest.fixture(autouse=True)
def _eager_off(monkeypatch):
    """Default to non-eager so the handler actually does something; opt back in per test."""
    monkeypatch.setattr(celery_module.settings, "celery_task_always_eager", False)


def test_warmup_is_noop_in_eager_mode(monkeypatch):
    monkeypatch.setattr(celery_module.settings, "celery_task_always_eager", True)

    called = False

    def _factory():
        nonlocal called
        called = True
        return _RecordingEngine()

    monkeypatch.setattr("app.ai.ocr.factory.get_ocr_engine", _factory)
    celery_module.warm_up_ocr_engine()
    assert called is False


def test_warmup_runs_engine_when_enabled(monkeypatch):
    engine = _RecordingEngine()
    monkeypatch.setattr("app.ai.ocr.factory.get_ocr_engine", lambda: engine)

    celery_module.warm_up_ocr_engine()

    # The adapter is constructed *and* run: constructing alone leaves the ONNX session
    # unloaded, which is the whole cost the warm-up exists to pay up front.
    assert len(engine.runs) == 1
    assert engine.runs[0].startswith(b"\x89PNG")


def test_warmup_swallows_provider_unavailable(monkeypatch):
    def _explode():
        raise ProviderUnavailableError("RapidOCR is not installed.")

    monkeypatch.setattr("app.ai.ocr.factory.get_ocr_engine", _explode)
    celery_module.warm_up_ocr_engine()  # must not raise


def test_warmup_swallows_failure_inside_run(monkeypatch):
    class _BadEngine:
        name = "bad"

        def run(self, image_bytes: bytes) -> list:
            raise RuntimeError("onnx session failed to load")

    monkeypatch.setattr("app.ai.ocr.factory.get_ocr_engine", lambda: _BadEngine())
    celery_module.warm_up_ocr_engine()  # must not raise


def _png(size: tuple[int, int]) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    # Noise-free but large enough that PNG stays above any tiny limit we set.
    Image.new("RGB", size, "white").save(buffer, format="PNG")
    return buffer.getvalue()


def test_compress_for_vision_memoises_repeat_calls():
    vision.clear_compress_cache()
    image = _png((400, 400))
    limit = 10  # forces the compression path

    first = vision._compress_for_vision(image, limit)
    assert vision._compress_encodes == 1

    second = vision._compress_for_vision(image, limit)
    assert second == first
    assert vision._compress_encodes == 1  # no second encode

    vision.clear_compress_cache()


def test_compress_for_vision_keys_on_limit_and_bytes():
    vision.clear_compress_cache()
    image = _png((400, 400))

    vision._compress_for_vision(image, 10)
    vision._compress_for_vision(image, 11)  # different limit -> different key
    assert vision._compress_encodes == 2

    vision._compress_for_vision(_png((401, 401)), 10)  # different bytes
    assert vision._compress_encodes == 3

    vision.clear_compress_cache()


def test_compress_cache_is_bounded():
    vision.clear_compress_cache()
    image = _png((400, 400))
    for limit in range(vision._COMPRESS_CACHE_MAX + 5):
        vision._compress_for_vision(image, limit + 1)
    assert len(vision._compress_cache) <= vision._COMPRESS_CACHE_MAX
    vision.clear_compress_cache()


def test_compress_returns_input_when_already_small():
    vision.clear_compress_cache()
    image = _png((8, 8))
    assert vision._compress_for_vision(image, 10_000_000) is image
    assert vision._compress_encodes == 0
