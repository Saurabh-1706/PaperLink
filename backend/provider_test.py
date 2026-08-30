"""Test both providers to find which has quota."""
import sys, time
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.core.config import settings
print(f"LLM_PROVIDER: {settings.llm_provider}")
print(f"GROQ_API_KEY:   {'set' if settings.groq_api_key else 'MISSING'}")
print(f"GEMINI_API_KEY: {'set' if settings.gemini_api_key else 'MISSING'}")

schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}

# Test Groq text
print("\n--- Groq text ---")
try:
    from app.ai.llm.groq import GroqProvider
    p = GroqProvider()
    t = time.perf_counter()
    r = p.complete_json('Return JSON: {"ok": true}', schema)
    print(f"result={r}  time={time.perf_counter()-t:.2f}s  calls={p.usage.calls}")
except Exception as e:
    print(f"ERROR: {e}")

# Test Groq vision
print("\n--- Groq vision (transcribe_page) ---")
try:
    from app.ai.llm.groq import GroqProvider
    from PIL import Image
    import io
    p2 = GroqProvider()
    # tiny 10x10 white image
    img = Image.new("RGB", (10, 10), color=255)
    buf = io.BytesIO(); img.save(buf, "PNG"); img_bytes = buf.getvalue()
    t = time.perf_counter()
    r2 = p2.transcribe_page(img_bytes, ["test line"])
    print(f"result={r2}  time={time.perf_counter()-t:.2f}s  calls={p2.usage.calls}")
except Exception as e:
    print(f"ERROR: {e}")

# Test Gemini
print("\n--- Gemini ---")
try:
    from app.ai.llm.gemini import GeminiProvider
    p3 = GeminiProvider()
    t = time.perf_counter()
    r3 = p3.complete_json('Return JSON: {"ok": true}', schema)
    print(f"result={r3}  time={time.perf_counter()-t:.2f}s  calls={p3.usage.calls}")
except Exception as e:
    print(f"ERROR: {e}")
