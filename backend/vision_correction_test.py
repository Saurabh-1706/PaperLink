"""Test transcribe_page on real answer sheet pages."""
import sys, time
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.core.config import get_settings
get_settings.cache_clear()

from app.modules.documents import pdf as M
from app.modules.extraction.pipeline import extract_document
from app.modules.answer_pipeline.pipeline import extract_answers
from app.modules.answer_pipeline.vision import validate_transcriptions
from app.ai.llm.groq import GroqProvider

provider = GroqProvider()
print(f"provider: {provider.name}  vision_model: {provider._vision_model_name}")

data = open(r'..\data\Biology-1-5.pdf', 'rb').read()
out = extract_document(data, 'as', 'answer_sheet', handwriting=True)
result = extract_answers(out.ir)
page_images = {a.page_number: a.image_bytes for a in out.artifacts}

print(f"answers={len(result.answers)}  low_conf={len(result.low_confidence_answer_ids)}")

# Test transcribe_page on page 2 directly
page2_lines = [b.text for b in sorted(out.ir.pages[1].blocks, key=lambda b: b.reading_order)]
print(f"\n--- Page 2 OCR lines ({len(page2_lines)}) ---")
for i, line in enumerate(page2_lines):
    print(f"  {i}: {repr(line)}")

print("\n--- Calling transcribe_page on page 2 ---")
t = time.perf_counter()
corrected = provider.transcribe_page(page_images[2], page2_lines)
print(f"done in {time.perf_counter()-t:.1f}s  calls={provider.usage.calls}")

if corrected:
    print("\n--- Corrected lines ---")
    for i, (orig, corr) in enumerate(zip(page2_lines, corrected)):
        changed = " <CHANGED>" if orig != corr else ""
        print(f"  {i}: {repr(corr)}{changed}")
else:
    print("transcribe_page returned None")

# Now run full validate_transcriptions
print("\n--- Full validate_transcriptions ---")
t = time.perf_counter()
corrected_answers, used = validate_transcriptions(
    result.answers, page_images, provider, result.low_confidence_answer_ids
)
print(f"done in {time.perf_counter()-t:.1f}s  used={used}  total_calls={provider.usage.calls}")

before = {a.answer_id: a.normalized_text for a in result.answers}
changed = [(a.answer_id, before[a.answer_id], a.normalized_text)
           for a in corrected_answers if a.normalized_text != before.get(a.answer_id)]
print(f"\n{len(changed)} answers corrected:")
for aid, old, new in changed:
    print(f"\n  {aid}:")
    print(f"    OCR: {repr(old[:100])}")
    print(f"    LLM: {repr(new[:100])}")
