"""End-to-end pipeline run over two real files, with no database and no Celery.

    python -m app.scripts.e2e_pipeline \
        --questions ../data/question-paper.pdf \
        --answers ../data/Biology.pdf \
        --out ./var/e2e

Every stage is the production one: ingestion and rendering, extraction to IR, the
question graph, the answer graph (including vision transcription validation), the
mapping engine and grading. The script only supplies the wiring the API layer would
otherwise supply, so that a failure here is a failure of the pipeline, not of a mock.

`--out` also gets an overlay PNG per page with every stored region drawn back onto the
rendered image. That overlay is the coordinate check required by
docs/03-coordinate-contract.md — it is the only thing that catches a wrong-reference-
frame bbox, which is otherwise silent.
"""
from __future__ import annotations

import argparse
import io
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.ai.llm.factory import get_llm_provider
from app.ai.ocr.factory import get_ocr_engine
from app.core.config import settings
from app.graphs.answer_graph import run_answer_graph
from app.graphs.mapping_graph import run_mapping_graph
from app.graphs.question_graph import run_question_graph
from app.modules.answer_pipeline.pipeline import merge_continuations
from app.modules.documents.validation import validate_pdf
from app.modules.extraction.ir import denormalize_bbox
from app.modules.extraction.pipeline import ExtractionOutput, extract_document
from app.modules.grading.engine import grade_assessment
from app.schemas.common import BBox, MappingType, ReviewStatus
from app.schemas.pipeline import ExtractedAnswer, ExtractedQuestion, MappingResult

OVERLAY_COLOURS = {"block": (120, 170, 255), "region": (220, 30, 30)}


@dataclass
class Report:
    questions: list[ExtractedQuestion] = field(default_factory=list)
    answers: list[ExtractedAnswer] = field(default_factory=list)
    mapping: MappingResult | None = None
    grades: list = field(default_factory=list)
    timings: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", required=True, help="printed question paper (PDF/image)")
    parser.add_argument("--answers", required=True, help="student answer sheet (PDF/image)")
    parser.add_argument("--out", default="./var/e2e")
    parser.add_argument(
        "--answer-pages",
        default=None,
        help="1-based inclusive page range of the answer sheet, e.g. 4-27. Everything "
        "before the first answer page (covers, marks grids) is otherwise segmented too.",
    )
    parser.add_argument("--no-llm", action="store_true", help="deterministic path only")
    parser.add_argument("--dpi", type=int, default=None)
    parser.add_argument("--json", dest="json_out", default=None, help="write the report as JSON")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = Report()

    provider = None if args.no_llm else get_llm_provider()
    if provider is not None and provider.name == "null":
        report.notes.append("LLM_PROVIDER resolves to the null provider: deterministic path only.")
        provider = None
    report.notes.append(f"ocr_engine={get_ocr_engine().name} llm={provider.name if provider else 'none'}")

    # ---------------------------------------------------------------- question paper
    started = time.perf_counter()
    question_bytes = Path(args.questions).read_bytes()
    validate_pdf(question_bytes)
    question_ir = extract_document(question_bytes, "qp", "question_paper", dpi=args.dpi)
    report.timings["extract_questions"] = time.perf_counter() - started

    started = time.perf_counter()
    question_result = run_question_graph(question_ir.ir, provider=provider)
    report.timings["question_pipeline"] = time.perf_counter() - started
    report.questions = question_result.questions

    # ----------------------------------------------------------------- answer sheet
    started = time.perf_counter()
    answer_bytes = Path(args.answers).read_bytes()
    validate_pdf(answer_bytes)
    if args.answer_pages:
        answer_bytes = _slice_pdf(answer_bytes, args.answer_pages)
    answer_ir = extract_document(
        answer_bytes, "as", "answer_sheet", dpi=args.dpi, handwriting=True
    )
    report.timings["extract_answers"] = time.perf_counter() - started

    page_images = {artifact.page_number: artifact.image_bytes for artifact in answer_ir.artifacts}
    started = time.perf_counter()
    answer_result = run_answer_graph(answer_ir.ir, provider=provider, page_images=page_images)
    report.timings["answer_pipeline"] = time.perf_counter() - started
    report.answers = answer_result.answers

    # --------------------------------------------------------------------- mapping
    started = time.perf_counter()
    mapping = run_mapping_graph(question_result.questions, answer_result.answers, provider=provider)
    report.timings["mapping"] = time.perf_counter() - started
    report.mapping = mapping

    # --------------------------------------------------------------------- grading
    started = time.perf_counter()
    logical = {answer.answer_id: answer for answer in merge_continuations(answer_result.answers)}
    report.grades = grade_assessment(
        mapping.mappings,
        {question.question_id: question for question in question_result.questions},
        logical,
        llm=provider,
    )
    report.timings["grading"] = time.perf_counter() - started

    _write_overlays(answer_ir, mapping, out_dir / "overlays")
    _print_report(report, question_result.ambiguities, answer_result.low_confidence_answer_ids)
    if args.json_out:
        Path(args.json_out).write_text(_report_json(report), encoding="utf-8")
        print(f"\nwrote {args.json_out}")


def _slice_pdf(data: bytes, spec: str) -> bytes:
    import pymupdf

    first, _, last = spec.partition("-")
    start = int(first) - 1
    end = int(last) - 1 if last else start
    source = pymupdf.open(stream=data, filetype="pdf")
    target = pymupdf.open()
    target.insert_pdf(source, from_page=start, to_page=end)
    return target.tobytes()


def _write_overlays(extraction: ExtractionOutput, mapping: MappingResult, out_dir: Path) -> None:
    from PIL import Image, ImageDraw

    out_dir.mkdir(parents=True, exist_ok=True)
    regions_by_page: dict[int, list[BBox]] = {}
    for entry in mapping.mappings:
        for region in entry.regions:
            regions_by_page.setdefault(region.page, []).append(region.bbox)

    for artifact in extraction.artifacts:
        image = Image.open(io.BytesIO(artifact.image_bytes)).convert("RGB")
        draw = ImageDraw.Draw(image)
        page = extraction.ir.page(artifact.page_number)
        for block in page.blocks if page else []:
            _rect(draw, image, block.bbox, OVERLAY_COLOURS["block"], 1)
        for bbox in regions_by_page.get(artifact.page_number, []):
            _rect(draw, image, bbox, OVERLAY_COLOURS["region"], 4)
        image.save(out_dir / f"page-{artifact.page_number:02d}.png")
    print(f"wrote {len(extraction.artifacts)} overlays to {out_dir}")


def _rect(draw, image, bbox: BBox, colour: tuple[int, int, int], width: int) -> None:
    x1, y1, x2, y2 = denormalize_bbox(bbox, image.width, image.height)
    draw.rectangle([x1, y1, x2, y2], outline=colour, width=width)


def _print_report(report: Report, ambiguities: list[str], low_confidence: list[str]) -> None:
    mapping = report.mapping
    assert mapping is not None
    questions = {question.question_id: question for question in report.questions}
    answers = {answer.answer_id: answer for answer in report.answers}
    grades = {(grade.question_id, grade.answer_id): grade for grade in report.grades}

    print("\n" + "=" * 100)
    print("QUESTIONS")
    print("=" * 100)
    for question in report.questions:
        pages = ",".join(str(page) for page in question.pages)
        print(
            f"  {question.normalized_number:<10} marks={str(question.max_marks):<5} "
            f"p{pages:<5} {question.text[:70]!r}"
        )
    print(f"  -> {len(report.questions)} questions, ambiguities={ambiguities or 'none'}")

    print("\n" + "=" * 100)
    print("MAPPINGS")
    print("=" * 100)
    ordered = sorted(
        (entry for entry in mapping.mappings if entry.question_id),
        key=lambda entry: questions[entry.question_id].order_index,
    )
    for entry in ordered:
        question = questions[entry.question_id]
        answer = answers.get(entry.answer_id or "")
        pages = ",".join(str(region.page) for region in entry.regions) or "-"
        label = answer.detected_label_display if answer else None
        grade = grades.get((entry.question_id, entry.answer_id))
        score = f"{grade.score}/{grade.max_score}" if grade else "-"
        print(
            f"  {question.normalized_number:<10} {entry.mapping_type.value:<10} "
            f"conf={entry.confidence:<6.3f} {entry.review_status.value:<14} "
            f"label={str(label)[:10]:<10} p{pages:<8} score={score}"
        )
        if answer:
            print(f"             {answer.normalized_text[:90]!r}")

    unmatched = [entry for entry in mapping.mappings if entry.mapping_type == MappingType.UNMATCHED]
    print(f"\n  unmatched answers: {len(unmatched)}")
    for entry in unmatched:
        answer = answers.get(entry.answer_id or "")
        pages = ",".join(str(region.page) for region in entry.regions)
        if answer:
            print(f"    p{pages:<8} label={str(answer.detected_label_display)[:10]:<10} "
                  f"{answer.normalized_text[:70]!r}")

    print("\n" + "=" * 100)
    print("SUMMARY")
    print("=" * 100)
    counts: dict[str, int] = {}
    for entry in mapping.mappings:
        counts[entry.mapping_type.value] = counts.get(entry.mapping_type.value, 0) + 1
    review = sum(1 for entry in mapping.mappings if entry.review_status == ReviewStatus.NEEDS_REVIEW)
    awarded = sum(grade.score for grade in report.grades)
    possible = sum(grade.max_score for grade in report.grades)
    multi_page = [answer for answer in merge_continuations(report.answers) if len(answer.regions) > 1]
    print(f"  answers segmented      : {len(report.answers)}")
    print(f"  logical answers        : {len(merge_continuations(report.answers))}")
    print(f"  multi-page answers     : {len(multi_page)}")
    print(f"  mapping types          : {counts}")
    print(f"  needs_review           : {review}")
    print(f"  low-confidence answers : {len(low_confidence)}")
    print(f"  graded                 : {awarded:.1f}/{possible:.1f}")
    print(f"  used_llm (mapping)     : {mapping.used_llm}")
    for key, value in report.timings.items():
        print(f"  time {key:<20}: {value:6.1f}s")
    for note in report.notes:
        print(f"  note: {note}")


def _report_json(report: Report) -> str:
    mapping = report.mapping
    payload = {
        "questions": [question.model_dump(mode="json") for question in report.questions],
        "answers": [answer.model_dump(mode="json") for answer in report.answers],
        "mappings": [entry.model_dump(mode="json") for entry in (mapping.mappings if mapping else [])],
        "grades": [grade.model_dump(mode="json") for grade in report.grades],
        "timings": report.timings,
        "settings": {
            "ocr_engine": settings.ocr_engine,
            "llm_model": settings.llm_model,
            "render_dpi": settings.render_dpi,
        },
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
