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

export function trip(key: string, cooldownSeconds: number = settings.llmQuotaCooldownSeconds): void {
  if (cooldownSeconds <= 0) return;
  cooldownUntil.set(key, Date.now() + cooldownSeconds * 1000);
}

export function reset(key?: string): void {
  if (key) cooldownUntil.delete(key);
  else cooldownUntil.clear();
}

/**
 * Recognizes a model that isn't callable at all with this key — a retired or renamed
 * model id, or one the key has no access to.
 *
 * This is worth separating from a quota refusal: a 429 clears on its own in seconds,
 * but a retired model id never will, and retrying it costs a wasted round trip on
 * *every* call (once per page, per model, forever) before the cascade falls through
 * to a working one. A transient 5xx ("high demand") is deliberately NOT included —
 * that one should move to the next model for this call but stay eligible for the next.
 */
export function isUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;
  if (status === 404 || status === 403) return true;
  const message = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    message.includes("not_found") ||
    message.includes("no longer available") ||
    message.includes("permission_denied") ||
    message.includes("api_key_service_blocked")
  );
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
