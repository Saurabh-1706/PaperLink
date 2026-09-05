/**
 * Textual similarity signals for stage 4. Port of
 * backend/app/modules/mapping_engine/similarity.py.
 *
 * Keyword overlap and fuzzy ratio are computed first and cost nothing — there is no
 * embedding step in this codebase at all; the "genuinely undecided" escalation path
 * goes straight to the bounded LLM call in mapping stage 5, not to a vector model.
 *
 * `fuzzyRatio` hand-rolls rapidfuzz's `token_set_ratio` (no JS equivalent library is
 * a dependency here): tokenize both strings into word sets, build the intersection
 * plus each side's unique remainder, and take the best of three LCS-based ratio
 * comparisons — rapidfuzz's `fuzz.ratio` is exactly an Indel-distance ratio, which
 * for insert/delete-only edits is `2 * lcsLength / (lenA + lenB)`.
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
  "it", "of", "on", "or", "that", "the", "to", "was", "what", "when", "where", "which",
  "who", "why", "with", "explain", "define", "describe", "state", "give", "write",
  "answer", "question", "following", "briefly", "your", "you",
]);

const TOKEN = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN) ?? [];
  return matches.filter((token) => !STOPWORDS.has(token) && token.length > 2);
}

export function keywordOverlap(questionText: string, answerText: string): number {
  const questionTokens = new Set(tokenize(questionText));
  const answerTokens = new Set(tokenize(answerText));
  if (questionTokens.size === 0 || answerTokens.size === 0) return 0.0;
  let intersectionSize = 0;
  for (const token of questionTokens) if (answerTokens.has(token)) intersectionSize++;
  return intersectionSize / Math.sqrt(questionTokens.size * answerTokens.size);
}

function lcsLength(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const curr = new Array<number>(m + 1).fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      curr[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[m];
}

/** Indel-distance ratio, 0..100 — the same formula rapidfuzz's `fuzz.ratio` uses. */
function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 100;
  return ((2 * lcsLength(a, b)) / total) * 100;
}

function tokenSetRatio(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).sort();
  const diffA = [...tokensA].filter((t) => !tokensB.has(t)).sort();
  const diffB = [...tokensB].filter((t) => !tokensA.has(t)).sort();

  const sect = intersection.join(" ");
  const combined1 = diffA.length > 0 ? [sect, diffA.join(" ")].filter(Boolean).join(" ") : sect;
  const combined2 = diffB.length > 0 ? [sect, diffB.join(" ")].filter(Boolean).join(" ") : sect;

  return Math.max(ratio(sect, combined1), ratio(sect, combined2), ratio(combined1, combined2));
}

export function fuzzyRatio(questionText: string, answerText: string): number {
  if (!questionText.trim() || !answerText.trim()) return 0.0;
  return tokenSetRatio(questionText.toLowerCase(), answerText.toLowerCase()) / 100;
}

/** Cheap deterministic blend. Short handwritten answers share little vocabulary with
 * their question, so this is a contributing signal — never the decision. */
export function semanticScore(questionText: string, answerText: string): number {
  const overlap = keywordOverlap(questionText, answerText);
  const fuzzy = fuzzyRatio(questionText, answerText);
  return Math.round((0.7 * overlap + 0.3 * fuzzy) * 10000) / 10000;
}

/** Present for parity with the Python source; not currently called by `stages.ts`
 * (there is no embedding stage in this codebase — see the module comment above). */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0.0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0.0;
}
