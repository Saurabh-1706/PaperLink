"""Per-provider quota circuit breaker.

Hosted LLM free tiers cap requests per day, and the provider SDKs answer a 429 with
several seconds of exponential backoff before giving up. Since no pipeline is allowed
to require an LLM, that backoff buys nothing once the quota is gone -- the caller's
deterministic fallback produces the result either way. So the first quota refusal
trips a breaker and every later call returns None immediately.

State is module-level because the factory builds a fresh provider per call: an
instance attribute would rediscover the exhausted quota on every single call.
It is also process-local -- each Celery worker learns this once for itself.
"""
from __future__ import annotations

import time

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

_blocked_until: dict[str, float] = {}

_QUOTA_MARKERS = ("resource_exhausted", "quota", "rate limit", "rate_limit", "429")


def is_quota_error(exc: Exception) -> bool:
    """True for a quota / rate-limit refusal, as opposed to a one-off failure.

    Matching is on the message rather than on provider exception types: every provider
    SDK is an optional, lazily imported dependency and must not be imported here.
    """
    status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if status == 429:
        return True
    message = str(exc).lower()
    return any(marker in message for marker in _QUOTA_MARKERS)


def trip(provider: str, model: str = "") -> None:
    cooldown = settings.llm_quota_cooldown_seconds
    if cooldown <= 0:
        return
    _blocked_until[provider] = time.monotonic() + cooldown
    log.warning(
        "llm quota exhausted; skipping calls during cooldown",
        extra={"provider": provider, "model": model, "cooldown_seconds": cooldown},
    )


def is_open(provider: str) -> bool:
    return _blocked_until.get(provider, 0.0) > time.monotonic()


def reset(provider: str | None = None) -> None:
    """Clear the cooldown. For tests and for an explicit operator retry."""
    if provider is None:
        _blocked_until.clear()
    else:
        _blocked_until.pop(provider, None)
