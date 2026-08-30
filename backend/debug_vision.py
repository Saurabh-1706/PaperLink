"""Debug raw Groq response from transcribe_page."""
import sys, time, io, base64, json
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.core.config import get_settings
get_settings.cache_clear()
from app.core.config import settings

from app.modules.documents import pdf as M
from app.ai.llm.parsing import content_text, parse_json
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage

data = open(r'..\data\Biology-1-5.pdf', 'rb').read()
renders = M.render_pages(data)
r = renders[1]
encoded = base64.b64encode(r.image_bytes).decode()

ocr_lines = ["2", "IA", "Space for writing", "SECTON-A", "@) 23S 9IRNA", "IROWWLENSAM"]
numbered = "\n".join(f"{i}: {line}" for i, line in enumerate(ocr_lines))
schema = {"type": "object", "properties": {"lines": {"type": "array", "items": {"type": "string"}}}, "required": ["lines"]}

prompt = (
    "This is a scanned handwritten exam answer sheet. "
    "The OCR below misread the handwriting. "
    "Using the image, correct each numbered line. "
    "Preserve question labels (e.g. '1.', '(a)', 'Q2') exactly. "
    "Return ONLY JSON with a 'lines' array of corrected strings "
    f"in the same order (exactly {len(ocr_lines)} items).\n\n"
    f"OCR lines:\n{numbered}\n\n"
    f"Return JSON matching: {json.dumps(schema)}"
)

# Test WITHOUT json_mode first
print("--- Without json_mode ---")
client = ChatGroq(model=settings.groq_vision_model, api_key=settings.groq_api_key, temperature=0, max_retries=1)
payload = [
    {"type": "text", "text": prompt},
    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
]
t = time.perf_counter()
resp = client.invoke([HumanMessage(content=payload)])
raw = content_text(resp.content)
print(f"time={time.perf_counter()-t:.1f}s")
print(f"raw response:\n{raw[:500]}")
parsed = parse_json(raw)
print(f"parsed: {parsed}")
if parsed:
    lines = parsed.get("lines")
    print(f"lines count={len(lines) if lines else None}  expected={len(ocr_lines)}  match={len(lines)==len(ocr_lines) if lines else False}")
