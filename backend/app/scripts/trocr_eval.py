"""Score a LineRecognizer against the committed transcription.

    python -m app.scripts.trocr_eval
    python -m app.scripts.trocr_eval --model microsoft/trocr-base-handwritten --device cuda

Runs the real routing path -- `LINE_SCRIPT_MODE=route` with the recogniser installed --
over the one page that has ground truth, and reports CER/WER against RapidOCR alone.

This is the check to run before enabling `LINE_RECOGNIZER` in production, and the only
thing that answers "is the bigger model worth it on my handwriting". It is a script
rather than a test because it needs torch, transformers and a model download, none of
which belong in the unit suite.
"""
from __future__ import annotations

import argparse
import sys
import time

from app.ai.evaluators.metrics import character_error_rate, word_error_rate
from app.ai.ocr.factory import get_ocr_engine, set_line_recognizer
from app.core.config import settings
from app.modules.documents import pdf as pdf_module
from app.modules.extraction import pipeline as extraction_pipeline
from tests.fixtures.ocr_ground_truth import (
    SCANNED_FIXTURES,
    SCANNED_GROUND_TRUTH,
    SCANNED_GROUND_TRUTH_PAGE,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _normalise(text: str) -> str:
    return " ".join(text.lower().split())


def _score(label: str, render, reference: str) -> tuple[float, float]:
    start = time.perf_counter()
    blocks = extraction_pipeline._ocr_blocks(render, get_ocr_engine(), handwriting=True)
    elapsed = time.perf_counter() - start

    hypothesis = _normalise(" ".join(block.text for block in blocks))
    cer = character_error_rate(hypothesis, reference)
    wer = word_error_rate(hypothesis, reference)
    replaced = sum(1 for block in blocks if block.recognizer)
    print(
        f"  {label:<34} CER {cer:.4f}  WER {wer:.4f}  "
        f"{elapsed:6.1f}s  lines {len(blocks):>3}  replaced {replaced:>3}"
    )
    return cer, wer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=settings.trocr_model)
    parser.add_argument("--device", default=settings.trocr_device, help="cpu or cuda")
    parser.add_argument("--batch-size", type=int, default=settings.trocr_batch_size)
    parser.add_argument("--ocr-engine", default="rapid")
    args = parser.parse_args()

    settings.ocr_engine = args.ocr_engine

    fixture = SCANNED_FIXTURES["biology_answer_sheet"]
    if not fixture.is_file():
        raise SystemExit(f"fixture not present: {fixture}")
    truth = SCANNED_GROUND_TRUTH["biology_answer_sheet_p4"]
    reference = _normalise(" ".join(truth.lines))

    render = next(
        r
        for r in pdf_module.render_pages(fixture.read_bytes())
        if r.page_number == SCANNED_GROUND_TRUTH_PAGE
    )
    print(f"page {SCANNED_GROUND_TRUTH_PAGE} of {fixture.name}, {len(reference)} reference chars\n")

    settings.line_script_mode = "telemetry"
    set_line_recognizer(None)
    baseline_cer, _ = _score(f"{args.ocr_engine} only", render, reference)

    from app.ai.ocr.trocr import TrOCRLineRecognizer

    print(f"\n  loading {args.model} on {args.device} (first run downloads weights)...")
    recognizer = TrOCRLineRecognizer(
        model_name=args.model,
        batch_size=args.batch_size,
        device=args.device,
        max_new_tokens=settings.trocr_max_new_tokens,
    )
    start = time.perf_counter()
    recognizer._lazy()
    print(f"  model ready in {time.perf_counter() - start:.1f}s\n")

    settings.line_script_mode = "route"
    set_line_recognizer(recognizer)
    try:
        routed_cer, _ = _score(f"+ {args.model.split('/')[-1]}", render, reference)
    finally:
        set_line_recognizer(None)

    if baseline_cer > 0:
        delta = (baseline_cer - routed_cer) / baseline_cer
        verdict = "worth enabling" if delta > 0 else "NOT worth enabling"
        print(f"\n  CER {baseline_cer:.4f} -> {routed_cer:.4f} ({delta:+.1%}) — {verdict}")


if __name__ == "__main__":
    main()
