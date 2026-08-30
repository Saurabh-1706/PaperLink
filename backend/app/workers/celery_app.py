"""Celery application. Handlers enqueue; nothing heavy runs in a request."""
from __future__ import annotations

import io

from celery import Celery
from celery.signals import worker_process_init

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

celery_app = Celery(
    "assessment",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.workers.tasks"],
)
celery_app.conf.update(
    task_always_eager=settings.celery_task_always_eager,
    task_eager_propagates=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
)


def _warmup_image() -> bytes:
    """A 32x32 white PNG — the smallest input that still forces a full OCR pass."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(buffer, format="PNG")
    return buffer.getvalue()


@worker_process_init.connect
def warm_up_ocr_engine(**_kwargs: object) -> None:
    """Load the OCR engine once per prefork process, at boot rather than mid-request.

    The engine singleton in `app.ai.ocr.factory` is process-local and Celery prefork
    gives one process per `--concurrency` slot, so without this the first task each
    worker handles pays the full ONNX session load inside a user's request.

    `get_ocr_engine()` only constructs the adapter; the ONNX session is built lazily on
    the first `run()`. Warming therefore means actually running the engine once, on a
    tiny in-memory white page.

    This must never take a worker down: if the engine is not installed or the session
    fails to build, the worker boots anyway and the cost is paid on first use, exactly
    as it was before this handler existed.
    """
    if settings.celery_task_always_eager:
        # Eager mode runs tasks in the caller (tests, local scripts). Loading ONNX
        # models there buys nothing and slows the suite down.
        return
    try:
        from app.ai.ocr.factory import get_ocr_engine

        engine = get_ocr_engine()
        engine.run(_warmup_image())
        log.info("ocr engine warmed up", extra={"engine": getattr(engine, "name", "unknown")})
    except Exception as exc:  # noqa: BLE001 - warm-up is best-effort by design
        log.warning("ocr engine warm-up skipped", extra={"error": str(exc)})
