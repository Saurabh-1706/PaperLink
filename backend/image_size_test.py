"""Check image sizes and test transcribe_page with resized images."""
import sys, io, base64, time
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.core.config import get_settings
get_settings.cache_clear()
from app.core.config import settings

from app.modules.documents import pdf as M
from PIL import Image

data = open(r'..\data\Biology-1-5.pdf', 'rb').read()
renders = M.render_pages(data)

print(f"groq_max_image_bytes: {settings.groq_max_image_bytes // 1024}KB")
print()
for r in renders:
    if r.classification.value == 'image':
        encoded = base64.b64encode(r.image_bytes).decode()
        over = len(encoded) > settings.groq_max_image_bytes
        print(f"page {r.page_number}: {r.image_width}x{r.image_height}  raw={len(r.image_bytes)//1024}KB  encoded={len(encoded)//1024}KB  OVER_LIMIT={over}")

# Test transcribe_page with JPEG-compressed image (much smaller)
print("\n--- Testing with JPEG compression ---")
r = renders[1]  # first image page
img = Image.open(io.BytesIO(r.image_bytes))
buf = io.BytesIO()
img.save(buf, format="JPEG", quality=70)
jpeg_bytes = buf.getvalue()
encoded_jpeg = base64.b64encode(jpeg_bytes).decode()
print(f"JPEG 70%: {len(jpeg_bytes)//1024}KB  encoded={len(encoded_jpeg)//1024}KB  over={len(encoded_jpeg) > settings.groq_max_image_bytes}")

from app.ai.llm.groq import GroqProvider
provider = GroqProvider()
page2_lines = ["2", "IA", "Space for writing", "SECTON-A", "@) 23S 9IRNA", "IROWWLENSAM"]
print(f"\nCalling transcribe_page with JPEG image ({len(jpeg_bytes)//1024}KB)...")
t = time.perf_counter()
result = provider.transcribe_page(jpeg_bytes, page2_lines)
print(f"done in {time.perf_counter()-t:.1f}s  calls={provider.usage.calls}")
print(f"result: {result}")
