"""Per-provider client-side rate limiting.

Free-tier LLM quotas are requests-PER-MINUTE, not a fixed total -- bursting past the
limit trips the provider's own 429, which then trips `breaker`'s cooldown and discards
every remaining call in the job (a 24-page answer sheet firing ~24 vision-correction
calls in a few seconds blows straight through a 15 rpm free tier on the first batch).

Pacing calls to stay under the limit means every call gets a real chance to succeed
instead of the whole burst getting shut out after the first one. This module blocks
the calling thread until a slot is free, rather than rejecting the call outright --
`vision.py` fires a handful of pages concurrently, so it must be thread-safe, and
sleeps happen outside the lock so other threads can keep checking their own turn.
"""
from __future__ import annotations

import threading
import time
from collections import deque

_lock = threading.Lock()
_windows: dict[str, deque[float]] = {}

_WINDOW_SECONDS = 60.0


def acquire(provider: str, requests_per_minute: int) -> None:
    """Block until a call for `provider` is safe to make under its RPM cap.

    A cap of 0 or less disables limiting entirely.
    """
    if requests_per_minute <= 0:
        return
    while True:
        with _lock:
            history = _windows.setdefault(provider, deque())
            now = time.monotonic()
            while history and now - history[0] >= _WINDOW_SECONDS:
                history.popleft()
            if len(history) < requests_per_minute:
                history.append(now)
                return
            wait_for = _WINDOW_SECONDS - (now - history[0]) + 0.01
        time.sleep(max(0.0, wait_for))


def reset(provider: str | None = None) -> None:
    """Clear tracked call history. For tests."""
    with _lock:
        if provider is None:
            _windows.clear()
        else:
            _windows.pop(provider, None)
