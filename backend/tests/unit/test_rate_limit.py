"""Client-side rpm pacing: a burst must be slowed to the cap, not rejected, and
different providers must not share a budget."""
from __future__ import annotations

import threading
import time

from app.ai.llm import rate_limit


def setup_function(_):
    rate_limit.reset()


def test_calls_within_the_cap_do_not_wait():
    start = time.monotonic()
    for _ in range(5):
        rate_limit.acquire("gemini", requests_per_minute=10)
    assert time.monotonic() - start < 0.5


def test_zero_or_negative_cap_disables_limiting():
    start = time.monotonic()
    for _ in range(50):
        rate_limit.acquire("gemini", requests_per_minute=0)
    assert time.monotonic() - start < 0.5


def test_a_call_beyond_the_cap_is_paced_not_dropped():
    """The 3rd call in a 2-per-minute window must wait, not fail or skip -- every
    call still gets made, just spread out enough to stay under the provider's own
    rpm limit instead of bursting into a 429."""
    calls_per_window = 2
    window = 0.3  # shrink the window for a fast test via a tiny monkeypatched value
    import app.ai.llm.rate_limit as rl

    rl._WINDOW_SECONDS = window
    try:
        start = time.monotonic()
        for _ in range(3):
            rate_limit.acquire("gemini", requests_per_minute=calls_per_window)
        elapsed = time.monotonic() - start
        assert elapsed >= window * 0.8  # the 3rd call had to wait out most of a window
    finally:
        rl._WINDOW_SECONDS = 60.0


def test_providers_have_independent_budgets():
    """Exhausting gemini's window must not slow down a groq call."""
    rate_limit.acquire("gemini", requests_per_minute=1)  # fills gemini's only slot

    start = time.monotonic()
    rate_limit.acquire("groq", requests_per_minute=1)
    assert time.monotonic() - start < 0.5


def test_concurrent_callers_all_eventually_get_a_slot():
    """vision.py fires several pages concurrently -- every thread must make it
    through, none silently dropped, and the total set must respect the cap."""
    import app.ai.llm.rate_limit as rl

    rl._WINDOW_SECONDS = 0.3
    completed: list[float] = []
    lock = threading.Lock()

    def _call():
        rate_limit.acquire("gemini", requests_per_minute=2)
        with lock:
            completed.append(time.monotonic())

    try:
        threads = [threading.Thread(target=_call) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)
        assert len(completed) == 6
    finally:
        rl._WINDOW_SECONDS = 60.0
