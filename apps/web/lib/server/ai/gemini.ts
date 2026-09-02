/**
 * Gemini client with an ordered model cascade. Port of backend/app/ai/llm/gemini.py,
 * adapted for a list of models instead of one: on a 429/quota error from model N, the
 * caller moves to model N+1 immediately rather than failing the whole call. Every
 * model in `GEMINI_MODEL_CASCADE` is paced (rate_limit) and breaker-protected
 * (breaker) independently, so a tripped model doesn't block the ones after it.
 *
 * This is also the sole OCR engine (docs/decisions/ADR-006-gemini-ocr-coordinates.md):
 * there is no local OCR engine anymore, so for scanned/handwritten pages Gemini's
 * structured output becomes the source of both text AND bounding boxes. CLAUDE.md's
 * "no pipeline may require an LLM to produce a result" still holds — every caller of
 * `callWithCascade` must have a deterministic fallback for when it returns null.
 */
import { GoogleGenAI } from "@google/genai";
import { settings } from "@/lib/server/config";
import * as breaker from "./breaker";
import * as rateLimit from "./rateLimit";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (!settings.geminiApiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey: settings.geminiApiKey });
  return client;
}

/** Best-effort JSON parse: strips a ```json fence if the model added one, then takes
 * the first balanced {...} or [...] span. Mirrors ai/llm/parsing.py::parse_json. */
export function parseJson<T = unknown>(text: string): T | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // fall through to bracket extraction
  }
  const start = stripped.search(/[[{]/);
  if (start === -1) return null;
  const open = stripped[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === open) depth++;
    else if (stripped[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function invoke(model: string, parts: Part[]): Promise<string | null> {
  const key = `gemini:${model}`;
  if (breaker.isOpen(key)) return null;
  await rateLimit.acquire(key, settings.llmRequestsPerMinute);

  const genai = getClient();
  if (!genai) return null;

  try {
    const response = await genai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    return response.text ?? null;
  } catch (err) {
    if (breaker.isQuotaError(err)) {
      breaker.trip(key);
    }
    return null;
  }
}

/** Walks `cascade` in order, returning the first model's parsed JSON result, or null
 * if every model failed/was cooling down. Callers must have a deterministic fallback. */
export async function callWithCascade<T = unknown>(
  cascade: readonly string[],
  parts: Part[]
): Promise<T | null> {
  for (const model of cascade) {
    const text = await invoke(model, parts);
    if (text === null) continue;
    const parsed = parseJson<T>(text);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function textPart(text: string): Part {
  return { text };
}

export function imagePart(imageBytes: Buffer, mimeType = "image/png"): Part {
  return { inlineData: { mimeType, data: imageBytes.toString("base64") } };
}

export function isConfigured(): boolean {
  return Boolean(settings.geminiApiKey);
}
