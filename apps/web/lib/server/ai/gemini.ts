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

  // Checked before pacing, not after: there is no point spending this model's
  // rate-limit budget on a call that cannot be made at all.
  const genai = getClient();
  if (!genai) return null;

  await rateLimit.acquire(key, settings.llmRequestsPerMinute);

  try {
    const response = await genai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    return response.text ?? null;
  } catch (err) {
    // Every failure here returns null, which moves the cascade to the next model.
    // What differs is whether this model is worth trying again on the *next* call:
    //   - retired / inaccessible (404, 403): nothing changes in the next few
    //     seconds, so cool it down for a long while — otherwise every page pays a
    //     wasted round trip to a dead model id before falling through.
    //   - quota (429): cool down for the configured quota window.
    //   - transient (503 "high demand", other 5xx, network): do NOT cool down;
    //     skip it for this call only and keep it eligible for the next one.
    if (breaker.isUnavailableError(err)) {
      breaker.trip(key, settings.llmUnavailableCooldownSeconds);
    } else if (breaker.isQuotaError(err)) {
      breaker.trip(key);
    }
    // Returning null is a deliberate, silent degradation for the *caller* (every
    // one of them has a deterministic fallback), but it must not be silent for the
    // operator: a permanent misconfiguration — a retired model id, a revoked key —
    // looks exactly like "the fallback ran", so without this the whole cascade can
    // fail on every page and the only symptom is empty OCR output.
    console.error(
      `[gemini] ${model} call failed:`,
      (err as { status?: number })?.status ?? "",
      (err as { message?: string })?.message ?? err
    );
    return null;
  }
}

/**
 * Walks `cascade` in order and returns the first usable result. ANY failure of a
 * model — unavailable, quota-refused, overloaded, cooling down, or a reply that
 * doesn't parse as JSON — moves on to the next model in the list; only when every
 * one of them has failed does this return null. Callers must have a deterministic
 * fallback for that case.
 */
export async function callWithCascade<T = unknown>(
  cascade: readonly string[],
  parts: Part[]
): Promise<T | null> {
  for (const model of cascade) {
    const text = await invoke(model, parts);
    if (text === null) continue;
    const parsed = parseJson<T>(text);
    if (parsed !== null) return parsed;
    // Reached the model but got back something unparseable — that is this model
    // failing to honour the contract, so it falls through to the next one too.
    console.error(`[gemini] ${model} returned an unparseable response`);
  }
  console.error(`[gemini] every model in the cascade failed: ${cascade.join(", ")}`);
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
