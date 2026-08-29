"""Graph routing: the LLM node must be reached only on the ambiguous branch, and a
provider failure must never stop a graph from producing a result."""
from __future__ import annotations

from app.graphs.answer_graph import run_answer_graph
from app.graphs.mapping_graph import run_mapping_graph
from app.graphs.question_graph import run_question_graph
from app.schemas.common import BBox, ExtractionMethod, PageClassification, Region
from app.schemas.ir import IRBlock, IRDocument, IRPage
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion


class RecordingProvider:
    name = "recording"

    def __init__(self, payload=None, transcription=None):
        self.payload = payload
        self.transcription = transcription
        self.calls = 0

    def complete_json(self, prompt, schema):
        self.calls += 1
        return self.payload

    def structure_blocks(self, prompt, schema):
        self.calls += 1
        return self.payload

    def transcribe(self, image_bytes, ocr_text):
        self.calls += 1
        return self.transcription


def _ir(lines: list[str], kind: str = "question_paper") -> IRDocument:
    blocks = [
        IRBlock(
            block_id=f"b{index}",
            text=text,
            bbox=BBox(x1=0.1, y1=0.05 + index * 0.08, x2=0.9, y2=0.10 + index * 0.08),
            confidence=0.95,
            reading_order=index,
        )
        for index, text in enumerate(lines)
    ]
    page = IRPage(
        page_number=1,
        width=595,
        height=842,
        dpi=300,
        classification=PageClassification.SEARCHABLE,
        extraction_method=ExtractionMethod.TEXT,
        blocks=blocks,
    )
    return IRDocument(document_id="d", kind=kind, page_count=1, pages=[page])


def test_question_graph_skips_the_model_when_numbering_is_clean():
    provider = RecordingProvider()
    result = run_question_graph(
        _ir(["1. First question text.", "2. Second question text."]), provider=provider
    )
    assert provider.calls == 0
    assert result.used_llm is False
    assert len(result.questions) == 2


def test_question_graph_routes_ambiguity_to_the_model():
    provider = RecordingProvider(
        payload={
            "questions": [
                {"display_number": "1", "block_ids": ["b0"]},
                {"display_number": "2", "block_ids": ["b1"]},
                {"display_number": "3", "block_ids": ["b2"]},
            ]
        }
    )
    result = run_question_graph(_ir(["1. First.", "3. Third.", "trailing prose"]), provider=provider)
    assert provider.calls == 1
    assert result.used_llm is True
    assert [q.display_number for q in result.questions] == ["1", "2", "3"]
    # Coordinates came from the stored blocks, not the model.
    assert result.questions[0].regions[0].bbox.x1 == 0.1


def test_question_graph_keeps_the_deterministic_result_when_the_model_fails():
    provider = RecordingProvider(payload=None)
    result = run_question_graph(_ir(["1. First.", "3. Third."]), provider=provider)
    assert provider.calls == 1
    assert [q.normalized_number for q in result.questions] == ["1", "3"]


def test_answer_graph_validates_only_low_confidence_regions():
    document = _ir(["scribbled answer text"], kind="answer_sheet")
    document.pages[0].blocks[0] = document.pages[0].blocks[0].model_copy(
        update={"confidence": 0.3, "low_confidence": True}
    )
    provider = RecordingProvider(transcription="a clean transcription")

    import app.modules.answer_pipeline.vision as vision

    original = vision.crop_region
    vision.crop_region = lambda image_bytes, region, padding=0.01: b"crop"
    try:
        result = run_answer_graph(document, provider=provider, page_images={1: b"png"})
    finally:
        vision.crop_region = original

    assert provider.calls == 1
    assert result.used_llm is True
    answer = result.answers[0]
    assert answer.raw_text == "scribbled answer text"      # raw OCR is preserved
    assert answer.normalized_text == "a clean transcription"
    assert answer.confidence >= 0.9


def test_answer_graph_does_not_call_the_model_on_confident_text():
    provider = RecordingProvider(transcription="unused")
    run_answer_graph(_ir(["1. a confident answer"], kind="answer_sheet"), provider=provider, page_images={1: b"x"})
    assert provider.calls == 0


def _question(number: str, text: str, order: int) -> ExtractedQuestion:
    return ExtractedQuestion(
        question_id=f"q-{number}",
        display_number=number,
        normalized_number=number,
        text=text,
        pages=[1],
        regions=[Region(page=1, bbox=[0.1, 0.1, 0.9, 0.2])],
        order_index=order,
        confidence=1.0,
    )


def _answer(identifier: str, text: str, y: float) -> ExtractedAnswer:
    return ExtractedAnswer(
        answer_id=identifier,
        raw_text=text,
        normalized_text=text,
        page_numbers=[1],
        regions=[Region(page=1, bbox=[0.1, y, 0.9, y + 0.05])],
        confidence=0.9,
    )


def test_mapping_graph_enters_the_llm_band_only_when_undecided():
    confident = run_mapping_graph(
        [_question("1", "Define velocity", 0)],
        [
            ExtractedAnswer(
                answer_id="a1",
                raw_text="velocity is displacement over time",
                normalized_text="velocity is displacement over time",
                detected_label="1",
                page_numbers=[1],
                regions=[Region(page=1, bbox=[0.1, 0.1, 0.9, 0.2])],
                confidence=0.9,
            )
        ],
        provider=RecordingProvider(),
    )
    assert confident.used_llm is False

    provider = RecordingProvider(payload={"answer_id": "a2", "reason": "closer topic"})
    undecided = run_mapping_graph(
        [_question("1", "Define the coefficient of thermal expansion", 0)],
        [_answer("a1", "some vague writing", 0.1), _answer("a2", "thermal expansion coefficient", 0.5)],
        provider=provider,
    )
    assert provider.calls >= 1
    assert undecided.used_llm is True
    chosen = [m for m in undecided.mappings if m.question_id == "q-1"][0]
    assert chosen.answer_id == "a2"
    assert chosen.evidence.llm_verdict == "selected"
