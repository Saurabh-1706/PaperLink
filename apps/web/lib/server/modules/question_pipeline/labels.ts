/**
 * Question-label parsing and normalisation. Port of
 * backend/app/modules/question_pipeline/labels.py — regex-for-regex, since the
 * exact patterns are load-bearing (this is what makes "11 a", "11(a)" and "Q11a"
 * collapse identically).
 *
 * Shared verbatim with the answer pipeline and the mapping engine — if it weren't,
 * matching would fail on whitespace alone.
 */

export const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

// Ordered by specificity: the first pattern that matches at the start of a line wins.
const TOP_LEVEL = String.raw`(?:Q(?:ues(?:tion)?)?\s*\.?\s*)?(?<num>\d{1,3})`;
const SUB = String.raw`(?:\s*[\(\[]?\s*(?<sub>[a-hA-H])\s*[\)\].]?)`;
// The opening bracket is optional: real papers print `(i)` and `i)` interchangeably,
// and a bare `ii)` heading a line is by far the commoner of the two.
const SUBSUB = String.raw`(?:\s*[\(\[]?\s*(?<subsub>[ivxIVX]{1,4})\s*[\)\].])`;

const PATTERNS: RegExp[] = [
  new RegExp(String.raw`^\s*${TOP_LEVEL}${SUB}${SUBSUB}\s*[.):]?\s*`, "i"),
  new RegExp(String.raw`^\s*${TOP_LEVEL}${SUB}\s*[.):]?\s+`, "i"),
  new RegExp(String.raw`^\s*${TOP_LEVEL}\s*[.):]\s*`, "i"),
  // "Q5 State ..." — the Q prefix carries the same weight as trailing punctuation.
  new RegExp(String.raw`^\s*Q(?:ues(?:tion)?)?\s*\.?\s*(?<num>\d{1,3})\s*[.):]?\s+`, "i"),
  new RegExp(String.raw`^\s*${TOP_LEVEL}\s*$`, "i"),
  new RegExp(String.raw`^\s*[\(\[]\s*(?<subsub>[ivx]{1,4})\s*[\)\].]\s*`, "i"),
  // `a) i) ...` — one block carrying both levels. Without this the roman level is
  // swallowed into the body and `12.b.ii` never becomes a row of its own.
  new RegExp(
    String.raw`^\s*[\(\[]?\s*(?<sub>[a-h])\s*[\)\].]\s*[\(\[]?\s*(?<subsub>[ivx]{1,4})\s*[\)\].]\s+`,
    "i"
  ),
  new RegExp(String.raw`^\s*[\(\[]\s*(?<sub>[a-h])\s*[\)\].]\s*`, "i"),
  new RegExp(String.raw`^\s*(?<sub>[a-h])\s*[\)\.]\s+`, "i"),
  // Bare roman, no brackets: `ii) Write the ...`. Kept last so `i` is only read as a
  // roman numeral once every lettered reading has been ruled out.
  new RegExp(String.raw`^\s*(?<subsub>[ivx]{1,4})\s*[\)\.]\s+`, "i"),
];

// Answer sheets add "Ans" / "Answer" prefixes.
export const ANSWER_PREFIX = /^\s*(?:ans(?:wer)?)\s*\.?\s*[:-]?\s*/i;

export interface ParsedLabel {
  /** Verbatim slice from the text, e.g. "11 (a)". */
  display: string;
  /** Canonical sortable form, e.g. "11.a". */
  normalized: string;
  /** 0 = top level, 1 = (a), 2 = (i). */
  level: 0 | 1 | 2;
  remainder: string;
  top: string | null;
  sub: string | null;
  subsub: string | null;
}

/** Parse a leading question label. Returns null when the line does not start with one. */
export function parseLabel(text: string, allowAnswerPrefix = false): ParsedLabel | null {
  let source = text;
  let offset = 0;
  if (allowAnswerPrefix) {
    const prefix = source.match(ANSWER_PREFIX);
    if (prefix) {
      offset = prefix[0].length;
      source = source.slice(offset);
    }
  }

  for (const pattern of PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    const groups = match.groups ?? {};
    const top = groups.num ?? null;
    const sub = groups.sub ?? null;
    const subsub = groups.subsub ?? null;
    if (!top && !sub && !subsub) continue;
    const matchEnd = match[0].length;
    const display = text.slice(0, offset + matchEnd).trim();
    const normalized = normalizeParts(top, sub, subsub);
    if (!normalized) continue;
    const level: 0 | 1 | 2 = top && !sub && !subsub ? 0 : sub && !subsub ? 1 : 2;
    return {
      display,
      normalized,
      level,
      remainder: source.slice(matchEnd).trim(),
      top,
      sub: sub ? sub.toLowerCase() : null,
      subsub: subsub ? subsub.toLowerCase() : null,
    };
  }
  return null;
}

export function normalizeParts(top: string | null, sub: string | null, subsub: string | null): string {
  const parts: string[] = [];
  if (top) parts.push(String(parseInt(top, 10)));
  if (sub) parts.push(sub.toLowerCase());
  if (subsub) parts.push(subsub.toLowerCase());
  return parts.join(".");
}

/**
 * U7 — deduplicate normalized labels within a parent scope. When two sub-questions
 * share the same label (e.g. two `ii)` under Q14.a), append `.2`, `.3` etc. to the
 * second and subsequent occurrences so they remain matchable.
 */
export function deduplicateNormalizedNumbers<
  T extends { normalizedNumber: string; questionId: string },
>(questions: T[]): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const question of questions) {
    const key = question.normalizedNumber;
    const count = seen.get(key) ?? 0;
    if (count === 0) {
      seen.set(key, 1);
      out.push(question);
    } else {
      seen.set(key, count + 1);
      const newNum = `${key}.${count + 1}`;
      out.push({ ...question, normalizedNumber: newNum, questionId: `q-${newNum}` });
    }
  }
  return out;
}

/** Collapse any rendering of a label to its canonical form, or null. */
export function normalizeLabel(text: string, allowAnswerPrefix = true): string | null {
  const parsed = parseLabel(text, allowAnswerPrefix);
  return parsed ? parsed.normalized : null;
}

type SortKeyPart = [0, number] | [1, string];

/** Sortable key for a normalized_number such as `11.a.ii`. */
export function sortKey(normalized: string): SortKeyPart[] {
  const key: SortKeyPart[] = [];
  const parts = normalized.split(".");
  parts.forEach((part, index) => {
    if (/^\d+$/.test(part)) {
      key.push([0, parseInt(part, 10)]);
    } else if (index === 2 && [...part].every((ch) => ch in ROMAN_VALUES)) {
      key.push([0, romanToInt(part)]);
    } else {
      key.push([1, part]);
    }
  });
  return key;
}

/** Compares two `sortKey()` outputs the way Python compares the equivalent tuples:
 * element-wise, and a proper prefix sorts before the longer sequence it's a prefix of. */
export function compareSortKeys(a: SortKeyPart[], b: SortKeyPart[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa[0] !== pb[0]) return pa[0] - pb[0];
    if (pa[0] === 0) {
      const na = pa[1] as number;
      const nb = pb[1] as number;
      if (na !== nb) return na - nb;
    } else {
      const sa = pa[1] as string;
      const sb = pb[1] as string;
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function compareNormalizedNumbers(a: string, b: string): number {
  return compareSortKeys(sortKey(a), sortKey(b));
}

export function romanToInt(value: string): number {
  let total = 0;
  let previous = 0;
  const chars = [...value.toLowerCase()].reverse();
  for (const char of chars) {
    const current = ROMAN_VALUES[char] ?? 0;
    total += current >= previous ? current : -current;
    previous = Math.max(previous, current);
  }
  return total;
}

export function parentOf(normalized: string): string | null {
  const parts = normalized.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : null;
}

/** Returns the leading integer from a normalised label, e.g. '18.a' -> 18. */
export function extractTopInt(normalized: string): number | null {
  const part = normalized.split(".")[0];
  return /^\d+$/.test(part) ? parseInt(part, 10) : null;
}
