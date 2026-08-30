"""The LLM is optional everywhere, so provider selection and quota exhaustion must
both degrade to the deterministic fallback rather than raising or stalling."""
from __future__ import annotations

import pytest

from app.ai.llm import breaker, factory, rate_limit
from app.ai.llm.gemini import GeminiProvider
from app.ai.llm.groq import GroqProvider
from app.ai.llm.parsing import content_text, parse_json


class _Boom(Exception):
    pass


@pytest.fixture(autouse=True)
def _clean():
    breaker.reset()
    rate_limit.reset()
    factory.set_provider(None)
    yield
    breaker.reset()
    rate_limit.reset()
    factory.set_provider(None)


class _FailingClient:
    def __init__(self, exc: Exception, counter: dict[str, int]) -> None:
        self._exc = exc
        self._counter = counter

    def invoke(self, _messages):
        self._counter["n"] += 1
        raise self._exc


def test_quota_error_is_recognised():
    assert breaker.is_quota_error(_Boom("429 RESOURCE_EXHAUSTED: quota exceeded"))
    assert breaker.is_quota_error(_Boom("Rate limit reached for model"))
    assert not breaker.is_quota_error(_Boom("503 backend unavailable"))


def test_breaker_is_per_provider():
    breaker.trip("gemini")
    assert breaker.is_open("gemini")
    assert not breaker.is_open("groq")


@pytest.mark.parametrize(
    "build",
    [
        lambda: GeminiProvider(model="m", api_key="k"),
        lambda: GroqProvider(model="m", vision_model="v", api_key="k"),
    ],
    ids=["gemini", "groq"],
)
def test_breaker_short_circuits_later_calls(build, monkeypatch):
    calls = {"n": 0}
    provider = build()
    client = _FailingClient(_Boom("429 RESOURCE_EXHAUSTED: quota exceeded"), calls)
    monkeypatch.setattr(provider, "_lazy", lambda *a, **kw: client)

    assert provider.complete_json("p", {}) is None
    assert provider.complete_json("p", {}) is None
    assert provider.transcribe(b"png", "ocr") is None
    assert calls["n"] == 1  # only the first call reaches the provider


def test_transient_failure_does_not_trip_the_breaker(monkeypatch):
    calls = {"n": 0}
    provider = GroqProvider(model="m", vision_model="v", api_key="k")
    monkeypatch.setattr(
        provider, "_lazy", lambda *a, **kw: _FailingClient(_Boom("503 unavailable"), calls)
    )

    assert provider.complete_json("p", {}) is None
    assert provider.complete_json("p", {}) is None
    assert calls["n"] == 2
    assert not breaker.is_open("groq")


def test_cooldown_of_zero_disables_the_breaker(monkeypatch):
    monkeypatch.setattr(breaker.settings, "llm_quota_cooldown_seconds", 0)
    breaker.trip("groq")
    assert not breaker.is_open("groq")


def test_groq_vision_is_optional():
    """No vision model configured -> no call, and handwriting keeps its OCR text."""
    provider = GroqProvider(model="m", vision_model="", api_key="k")
    assert provider.transcribe(b"png", "ocr") is None


def test_gemini_vision_can_use_a_different_model(monkeypatch):
    """GEMINI_VISION_MODEL lets vision (handwriting transcription) run on a
    different model than text calls (mapping ambiguity, question repair) without
    the two stages needing separate providers."""
    provider = GeminiProvider(model="text-model", vision_model="vision-model", api_key="k")
    seen: list[str] = []

    def _fake_lazy(model_name):
        seen.append(model_name)
        return None  # no client -> _invoke returns None before any network call

    monkeypatch.setattr(provider, "_lazy", _fake_lazy)
    provider.complete_json("p", {})
    provider.transcribe(b"png", "ocr")
    assert seen == ["text-model", "vision-model"]


def test_gemini_vision_model_defaults_to_the_text_model(monkeypatch):
    """Unlike Groq (where an empty vision model is a deliberate off switch), Gemini
    vision must not silently go dark just because GEMINI_VISION_MODEL was never set."""
    import app.ai.llm.gemini as gemini_module

    monkeypatch.setattr(gemini_module.settings, "gemini_vision_model", "")
    provider = GeminiProvider(model="text-model", api_key="k")
    assert provider._vision_model_name == "text-model"


def test_groq_rejects_oversized_crops(monkeypatch):
    monkeypatch.setattr(breaker.settings, "groq_max_image_bytes", 10)
    provider = GroqProvider(model="m", vision_model="v", api_key="k")

    def _fail(*_a, **_kw):
        raise AssertionError("oversized crop must not reach the provider")

    monkeypatch.setattr(provider, "_lazy", _fail)
    assert provider.transcribe(b"x" * 11, "ocr") is None


def test_factory_selects_by_config(monkeypatch):
    monkeypatch.setattr(factory.settings, "llm_provider", "groq")
    monkeypatch.setattr(factory.settings, "groq_api_key", "k")
    monkeypatch.setattr(factory.settings, "vision_provider", "auto")
    assert factory.get_llm_provider().name == "groq"
    assert factory.get_vision_provider().name == "groq"


def test_vision_can_route_to_a_second_provider(monkeypatch):
    monkeypatch.setattr(factory.settings, "llm_provider", "groq")
    monkeypatch.setattr(factory.settings, "groq_api_key", "k")
    monkeypatch.setattr(factory.settings, "gemini_api_key", "g")
    monkeypatch.setattr(factory.settings, "vision_provider", "gemini")
    assert factory.get_llm_provider().name == "groq"
    assert factory.get_vision_provider().name == "gemini"


def test_missing_credentials_fall_back_to_null(monkeypatch):
    monkeypatch.setattr(factory.settings, "llm_provider", "groq")
    monkeypatch.setattr(factory.settings, "groq_api_key", None)
    assert factory.get_llm_provider().name == "null"


def test_openai_is_not_wired_yet(monkeypatch):
    monkeypatch.setattr(factory.settings, "llm_provider", "openai")
    monkeypatch.setattr(factory.settings, "openai_api_key", "k")
    assert factory.get_llm_provider().name == "null"


def test_parse_json_salvages_fenced_and_block_responses():
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json("no json here") is None
    assert content_text([{"type": "text", "text": "{\"a\": 1}"}]) == '{"a": 1}'
