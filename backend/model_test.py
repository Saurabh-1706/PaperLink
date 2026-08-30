"""Test Groq vision models with correct request format."""
import sys, time, io, base64
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)

from app.core.config import get_settings
get_settings.cache_clear()
from app.core.config import settings
print(f"GROQ_VISION_MODEL: {settings.groq_vision_model}")
print(f"GROQ_JSON_MODE: {settings.groq_json_mode}")

from PIL import Image
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage

# tiny white test image
img = Image.new("RGB", (50, 50), color=200)
buf = io.BytesIO(); img.save(buf, "PNG")
encoded = base64.b64encode(buf.getvalue()).decode()

for model in ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]:
    for json_mode in [False, True]:
        kwargs = {}
        if json_mode:
            kwargs["model_kwargs"] = {"response_format": {"type": "json_object"}}
        try:
            client = ChatGroq(
                model=model, api_key=settings.groq_api_key,
                temperature=0, max_retries=1, timeout=15, **kwargs
            )
            payload = [
                {"type": "text", "text": 'Describe this image in one word. Return JSON: {"word": "..."}'},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
            ]
            t = time.perf_counter()
            resp = client.invoke([HumanMessage(content=payload)])
            print(f"OK  model={model}  json_mode={json_mode}  {time.perf_counter()-t:.1f}s  -> {str(resp.content)[:80]}")
        except Exception as e:
            print(f"FAIL  model={model}  json_mode={json_mode}  -> {str(e)[:100]}")
