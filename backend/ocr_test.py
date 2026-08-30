"""Timing probe: measures each stage of the pipeline independently."""
import sys, time, io
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.modules.documents import pdf as M
from app.modules.extraction.preprocess import preprocess_for_ocr, estimate_skew
from app.ai.ocr.factory import get_ocr_engine
from PIL import Image

print("=== OCR ENGINE INIT ===")
t = time.perf_counter()
engine = get_ocr_engine()
print(f"engine init: {time.perf_counter()-t:.2f}s  name={engine.name}")

print("\n=== RENDER PAGES ===")
t = time.perf_counter()
data = open(r'..\data\Biology-1-5.pdf', 'rb').read()
renders = M.render_pages(data)
print(f"render: {time.perf_counter()-t:.2f}s  pages={len(renders)}")
for r in renders:
    print(f"  page {r.page_number}: {r.classification.value}  {r.image_width}x{r.image_height}")

print("\n=== PER-PAGE BREAKDOWN (image pages only) ===")
for r in renders:
    if r.classification.value != 'image':
        print(f"  page {r.page_number}: SKIPPED (searchable, native text)")
        continue

    img = Image.open(io.BytesIO(r.image_bytes)).convert('L')

    t = time.perf_counter()
    angle = estimate_skew(img)
    skew_t = time.perf_counter() - t

    t = time.perf_counter()
    res = preprocess_for_ocr(r.image_bytes, target_long_edge=2600, deskew=True)
    pre_t = time.perf_counter() - t

    t = time.perf_counter()
    words = engine.run(res.image_bytes)
    ocr_t = time.perf_counter() - t

    print(f"  page {r.page_number}: skew={skew_t:.2f}s  preprocess={pre_t:.2f}s  ocr={ocr_t:.2f}s  words={len(words)}")
    for w in words[:8]:
        print(f"    {repr(w.text):<30} conf={w.confidence:.2f}")

print("\n=== SECOND ENGINE CALL (singleton check) ===")
t = time.perf_counter()
engine2 = get_ocr_engine()
print(f"get_ocr_engine() again: {time.perf_counter()-t:.4f}s  same={engine is engine2}")
