/**
 * Per-model circuit breaker. Port of backend/app/ai/llm/breaker.py, keyed by
 * `<provider>:<model>` instead of just `<provider>` — the whole point of the model
 * cascade (docs: Gemini model fallback) is that tripping one model must not stop the
 * caller from trying the next one in the list.
 */
import { settings } from "@/lib/server/config";

const cooldownUntil = new Map<string, number>();

export function isOpen(key: string): boolean {
  const until = cooldownUntil.get(key);
  return until !== undefined && Date.now() < until;
}

export function trip(key: string): void {
  if (settings.llmQuotaCooldownSeconds <= 0) return;
  cooldownUntil.set(key, Date.now() + settings.llmQuotaCooldownSeconds * 1000);
}

export function reset(key?: string): void {
  if (key) cooldownUntil.delete(key);
  else cooldownUntil.clear();
}

/** Recognizes a quota/rate-limit refusal across the shapes @google/genai throws. */
export function isQuotaError(err: unknown): boolean {
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  if (status === 429) return true;
  const message = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit")
  );
}
