"""Find the 40s delay inside validate_transcriptions when quota is exhausted."""
import sys, time
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.ai.llm.factory import get_llm_provider
from app.ai.llm import breaker

provider = get_llm_provider()
print(f"provider: {provider.name}")
print(f"breaker open before: {breaker.is_open(provider.name)}")

# Simulate a tripped breaker
breaker.trip(provider.name)
print(f"breaker open after trip: {breaker.is_open(provider.name)}")

# Test transcribe_page with open breaker — should return None instantly
t = time.perf_counter()
result = provider.transcribe_page(b"fake", ["line1", "line2"])
print(f"transcribe_page with open breaker: {result}  time={time.perf_counter()-t:.3f}s")

# Test transcribe with open breaker
t = time.perf_counter()
result2 = provider.transcribe(b"fake", "ocr text")
print(f"transcribe with open breaker: {result2}  time={time.perf_counter()-t:.3f}s")

breaker.reset(provider.name)
print("breaker reset")

# Now test what happens when transcribe_page returns None — does fallback loop cause delay?
from app.modules.documents import pdf as M
from app.modules.extraction.pipeline import extract_document
from app.modules.answer_pipeline.pipeline import extract_answers
from app.modules.answer_pipeline.vision import validate_transcriptions

data = open(r'..\data\Biology-1-5.pdf', 'rb').read()
out = extract_document(data, 'as', 'answer_sheet', handwriting=True)
result_ans = extract_answers(out.ir)
page_images = {a.page_number: a.image_bytes for a in out.artifacts}
print(f"extraction done, {len(result_ans.answers)} answers, {len(result_ans.low_confidence_answer_ids)} low-conf")

# Trip breaker again to simulate quota exhausted
breaker.trip(provider.name)
print(f"breaker tripped again, is_open={breaker.is_open(provider.name)}")

# Time validate_transcriptions with open breaker
t = time.perf_counter()
corrected, used = validate_transcriptions(
    result_ans.answers, page_images, provider, result_ans.low_confidence_answer_ids
)
print(f"validate_transcriptions: {time.perf_counter()-t:.2f}s  used={used}")
