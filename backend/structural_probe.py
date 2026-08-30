"""Phase-5 decision probe: measure what TrOCR could actually fix.

CER is not the decision-relevant number. Everything structural in the answer pipeline
is decided from raw OCR text BEFORE `validate_transcriptions` can repair anything
(answer_graph.py:17), so this probe counts the three things the vision LLM can never
undo:

  1. blocks deleted by `_is_noise_block` before segmentation ever sees them
  2. how many segments `extract_answers` produces
  3. how many answers carry a `detected_label` (the mapping engine's strongest signal)

Run:  python structural_probe.py ../data/Biology-1-5.pdf
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from app.core.config import settings
from app.modules.answer_pipeline.pipeline import (
    _is_noise_block,
    extract_answers,
    parse_answer_label,
)
from app.modules.extraction.pipeline import extract_document


def main(path: str) -> None:
    data = Path(path).read_bytes()
    t0 = time.perf_counter()
    out = extract_document(data, document_id="probe", kind="answer", handwriting=True)
    elapsed = time.perf_counter() - t0

    pairs = [(page.page_number, b) for page in out.ir.pages for b in page.blocks]
    all_blocks = [b for _p, b in pairs]
    dropped = [(p, b) for p, b in pairs if _is_noise_block(b)]
    kept = [b for b in all_blocks if not _is_noise_block(b)]
    labelled_blocks = [b for b in kept if parse_answer_label(b.text)]

    result = extract_answers(out.ir)
    with_label = [a for a in result.answers if a.detected_label]

    print(f"\n=== structural probe: {path} ===")
    print(
        f"engine={settings.ocr_engine}  line_script_mode={settings.line_script_mode}"
        f"  line_recognizer={settings.line_recognizer}"
    )
    print(f"wall={elapsed:.2f}s  pages={len(out.ir.pages)}\n")

    mean_conf = sum(b.confidence for b in all_blocks) / max(1, len(all_blocks))
    below = [b for b in all_blocks if b.confidence < settings.answer_confidence_threshold]
    print(f"blocks total           {len(all_blocks)}")
    print(f"  dropped as noise     {len(dropped)}   <- deleted before segmentation")
    print(f"  survived             {len(kept)}")
    print(f"mean block confidence  {mean_conf:.4f}")
    print(f"below answer thresh    {len(below)}/{len(all_blocks)}\n")

    print(f"segments produced      {len(result.answers)}")
    print(f"  with detected_label  {len(with_label)}")
    print(f"  blocks parsed as label {len(labelled_blocks)}")
    print(
        f"low-confidence answers {len(result.low_confidence_answer_ids)}/{len(result.answers)}\n"
    )

    print("--- dropped blocks (page, conf, text) ---")
    for page_number, b in dropped:
        print(f"  p{page_number} conf={b.confidence:.3f}  {b.text!r}")

    print("\n--- segments (label, conf, first 70 chars) ---")
    for a in result.answers:
        print(f"  {str(a.detected_label):>8}  conf={a.confidence:.3f}  {a.raw_text[:70]!r}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../data/Biology-1-5.pdf")
