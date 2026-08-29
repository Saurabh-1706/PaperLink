"""Celery application. Handlers enqueue; nothing heavy runs in a request."""
from __future__ import annotations

from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "assessment",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.update(
    task_always_eager=settings.celery_task_always_eager,
    task_eager_propagates=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
)
