"""The line recogniser is optional and hallucination-prone, so the guards that decide
whether its output ever reaches the IR are tested without the model, and the adapter is
tested for degrading to ProviderUnavailableError rather than crashing at import."""
from __future__ import annotations

import builtins

import pytest

from app.ai.ocr.recognizer import (
    LineRecognizer,
    NullLineRecognizer,
    RecognizedLine,
    StubLineRecognizer,
)
from app.ai.ocr.trocr import (
    TrOCRLineRecognizer,
    clamp_unit,
    plausible_length,
    should_replace,
)
from app.core.errors import ProviderUnavailableError

FLOOR = 0.85


# --- plausible_length -------------------------------------------------------------


@pytest.mark.parametrize(
    "candidate,ocr_text,expected",
    [
        ("photosynthesis", "photosynthesis", True),      # identical
        ("photosynthesis", "photosynthesls", True),      # same length, different chars
        ("abc", "abcdefghij", False),                    # ratio 0.3 -> too short
        ("abcd", "abcdefghij", True),                    # ratio 0.4 -> exactly at low
        ("a" * 25, "abcdefghij", True),                  # ratio 2.5 -> exactly at high
        ("a" * 26, "abcdefghij", False),                 # ratio 2.6 -> too long
        ("", "abcdefghij", False),                       # empty candidate
        ("   ", "abcdefghij", False),                    # whitespace candidate
        ("anything", "", True),                          # no OCR signal, non-empty wins
        ("", "", False),                                 # nothing at all
        ("   ", "   ", False),                           # whitespace both sides
    ],
)
def test_plausible_length(candidate, ocr_text, expected):
    assert plausible_length(candidate, ocr_text) is expected


def test_plausible_length_bounds_are_tunable():
    assert plausible_length("abcde", "abcdefghij", low=0.5, high=1.0) is True
    assert plausible_length("abcde", "abcdefghij", low=0.6, high=1.0) is False


def test_plausible_length_ignores_surrounding_whitespace():
    assert plausible_length("  photosynthesis  ", "  photosynthesis  ") is True


# --- should_replace ---------------------------------------------------------------


def test_should_replace_accepts_a_better_candidate_on_a_weak_line():
    candidate = RecognizedLine(text="photosynthesis", confidence=0.80)
    assert should_replace(candidate, "phclosynlhesis", 0.42, FLOOR) is True


def test_should_replace_refuses_when_ocr_line_is_already_high_confidence():
    candidate = RecognizedLine(text="photosynthesis", confidence=0.99)
    assert should_replace(candidate, "photosynthesis", 0.92, FLOOR) is False
    # exactly at the floor counts as high confidence
    assert should_replace(candidate, "photosynthesis", FLOOR, FLOOR) is False


def test_should_replace_refuses_an_empty_candidate():
    candidate = RecognizedLine(text="", confidence=0.99)
    assert should_replace(candidate, "photosynthesis", 0.30, FLOOR) is False


def test_should_replace_refuses_a_whitespace_candidate():
    candidate = RecognizedLine(text="   \n\t ", confidence=0.99)
    assert should_replace(candidate, "photosynthesis", 0.30, FLOOR) is False


def test_should_replace_refuses_a_candidate_that_is_too_short():
    candidate = RecognizedLine(text="ph", confidence=0.99)
    assert should_replace(candidate, "photosynthesis", 0.30, FLOOR) is False


def test_should_replace_refuses_a_hallucinated_continuation():
    # the classic failure: a smudge decoded as a fluent invented sentence
    candidate = RecognizedLine(
        text="The process by which green plants convert sunlight into chemical energy.",
        confidence=0.97,
    )
    assert should_replace(candidate, "photosyn", 0.30, FLOOR) is False


def test_should_replace_refuses_a_candidate_less_confident_than_the_ocr_line():
    candidate = RecognizedLine(text="photosynthesis", confidence=0.35)
    assert should_replace(candidate, "phclosynlhesis", 0.60, FLOOR) is False


def test_should_replace_accepts_an_equally_confident_candidate():
    candidate = RecognizedLine(text="photosynthesis", confidence=0.60)
    assert should_replace(candidate, "phclosynlhesis", 0.60, FLOOR) is True


def test_should_replace_accepts_when_ocr_text_is_empty_but_line_is_weak():
    candidate = RecognizedLine(text="photosynthesis", confidence=0.55)
    assert should_replace(candidate, "", 0.10, FLOOR) is True


# --- clamp_unit -------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [(-0.5, 0.0), (0.0, 0.0), (0.5, 0.5), (1.0, 1.0), (1.0000001, 1.0), (float("nan"), 0.0)],
)
def test_clamp_unit(value, expected):
    assert clamp_unit(value) == expected


# --- ABC conformance --------------------------------------------------------------


def test_null_recognizer_conforms_and_returns_nothing():
    recognizer = NullLineRecognizer()
    assert isinstance(recognizer, LineRecognizer)
    assert recognizer.name == "none"
    assert recognizer.read([b"crop-a", b"crop-b"]) == []
    assert recognizer.read([]) == []


def test_stub_recognizer_conforms_and_is_deterministic():
    recognizer = StubLineRecognizer()
    assert isinstance(recognizer, LineRecognizer)
    assert recognizer.name == "stub"

    registered = RecognizedLine(text="photosynthesis", confidence=0.9)
    recognizer.register(b"crop-a", registered)
    recognizer.set_default(RecognizedLine(text="fallback", confidence=0.1))

    first = recognizer.read([b"crop-a", b"crop-b"])
    assert first == [registered, RecognizedLine(text="fallback", confidence=0.1)]
    assert recognizer.read([b"crop-a", b"crop-b"]) == first  # deterministic


def test_stub_recognizer_returns_one_line_per_crop_with_no_default():
    recognizer = StubLineRecognizer()
    out = recognizer.read([b"a", b"b", b"c"])
    assert out == [RecognizedLine(text="", confidence=0.0)] * 3


def test_abstract_recognizer_cannot_be_instantiated():
    with pytest.raises(TypeError):
        LineRecognizer()  # type: ignore[abstract]


# --- TrOCR adapter without transformers -------------------------------------------


def test_trocr_constructor_does_not_touch_transformers():
    # heavy deps are lazy: constructing the adapter must not import anything
    recognizer = TrOCRLineRecognizer("microsoft/trocr-base-handwritten")
    assert isinstance(recognizer, LineRecognizer)
    assert recognizer.name == "trocr"


def test_trocr_read_of_no_crops_is_a_no_op():
    assert TrOCRLineRecognizer("microsoft/trocr-base-handwritten").read([]) == []


def test_trocr_raises_provider_unavailable_without_transformers(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "transformers" or name.startswith("transformers."):
            raise ImportError("No module named 'transformers'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    recognizer = TrOCRLineRecognizer("microsoft/trocr-base-handwritten")
    with pytest.raises(ProviderUnavailableError) as excinfo:
        recognizer.read([b"crop"])
    assert "transformers" in str(excinfo.value)


def test_trocr_raises_provider_unavailable_without_torch(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch" or name.startswith("torch."):
            raise ImportError("No module named 'torch'")
        if name == "transformers" or name.startswith("transformers."):
            # stand in for an installed transformers so the torch branch is reached
            import types

            module = types.ModuleType("transformers")
            module.TrOCRProcessor = object
            module.VisionEncoderDecoderModel = object
            return module
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    recognizer = TrOCRLineRecognizer("microsoft/trocr-base-handwritten")
    with pytest.raises(ProviderUnavailableError) as excinfo:
        recognizer.read([b"crop"])
    assert "torch" in str(excinfo.value)


def test_cuda_device_without_a_gpu_fails_with_a_clear_message(monkeypatch):
    """Asking for cuda on a CPU box must fail early and legibly.

    Without the guard this surfaces as a torch assertion from inside .to(), after the
    weights have already been downloaded and loaded -- minutes of work and a stack
    trace that names neither the setting nor the fix.
    """
    torch = pytest.importorskip("torch")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)

    from app.ai.ocr.trocr import TrOCRLineRecognizer
    from app.core.errors import ProviderUnavailableError

    recognizer = TrOCRLineRecognizer(model_name="microsoft/trocr-small-handwritten", device="cuda")
    with pytest.raises(ProviderUnavailableError) as excinfo:
        recognizer._lazy()
    assert "TROCR_DEVICE" in str(excinfo.value)
    assert "cuda" in str(excinfo.value)
