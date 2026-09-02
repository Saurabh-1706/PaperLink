/**
 * Per-model client-side rate limiting. Port of backend/app/ai/llm/rate_limit.py.
 *
 * Free-tier quotas are requests-PER-MINUTE, not a fixed total — bursting past the
 * limit trips the provider's own 429, which then trips the breaker and discards
 * every remaining call. Pacing calls to stay under the limit means every call gets a
 * real chance to succeed instead of the whole burst getting shut out after the first
 * one (e.g. a 24-page answer sheet firing ~24 OCR calls in a few seconds).
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blocks until a call for `key` is safe to make under its RPM cap. 0 disables limiting. */
export async function acquire(key: string, requestsPerMinute: number): Promise<void> {
  if (requestsPerMinute <= 0) return;
  for (;;) {
    const now = Date.now();
    const history = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (history.length < requestsPerMinute) {
      history.push(now);
      windows.set(key, history);
      return;
    }
    windows.set(key, history);
    const waitFor = WINDOW_MS - (now - history[0]) + 10;
    await sleep(Math.max(0, waitFor));
  }
}

export function reset(key?: string): void {
  if (key) windows.delete(key);
  else windows.clear();
}
