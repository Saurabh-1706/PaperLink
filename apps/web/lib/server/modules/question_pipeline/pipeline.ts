/**
 * Question pipeline: IR-JSON in, structured questions out. Port of
 * backend/app/modules/question_pipeline/pipeline.py.
 *
 * Independent module — it knows nothing about answers. Deterministic parsing
 * first; ambiguity routing (and only that) may reach a model, via
 * `graphs/question_graph.ts`.
 */
import { settings } from "@/lib/server/config";
import type { IRBlock, IRDocument } from "../extraction/types";
import { orderedBlocks } from "../extraction/types";
import type { Region } from "../common";
import { unionAll } from "../common";
import { parentOf, parseLabel, type ParsedLabel } from "./labels";
import type { ExtractedQuestion, QuestionPipelineResult } from "./types";

const MARKS_PATTERNS: RegExp[] = [
  /[[(]\s*(\d{1,3})\s*(?:marks?|m)\s*[\])]/i,
  /\b(\d{1,3})\s*marks?\b/i,
  /[[(]\s*(\d{1,3})\s*[\])]\s*$/,
];

// Blocks that are page furniture rather than question text. A printed paper puts its
// marks in a right-hand column and its section headings on their own line; both land
// inside the preceding question's block span. Left in, they corrupt the body text,
// stretch the question's region across the full page width, and a trailing section
// heading pushes the marks marker off the end of the string where MARKS_PATTERNS can
// no longer see it.
const MARKS_ONLY = /^\s*[[(]\s*(\d{1,3})\s*[\])]\s*$/;
const SECTION_HEADER = /^\s*sections?\b.{0,8}$/i;

const OPTIONAL_PATTERNS: RegExp[] = [
  /\battempt\s+any\b/i,
  /\banswer\s+any\b/i,
  /\beither\b.*\bor\b/i,
  /\bor\b\s*$/i,
  /\boptional\b/i,
];

interface Candidate {
  label: ParsedLabel;
  page: number;
  block: IRBlock;
  position: number;
}

export function extractQuestions(document: IRDocument): QuestionPipelineResult {
  const ordered = orderedBlocks(document);
  const candidates = detectNumbering(ordered);
  if (candidates.length === 0) {
    return {
      questions: [],
      ambiguities: ["no_numbering_detected"],
      orphanBlockIds: ordered.map((o) => o.block.blockId),
      usedLlm: false,
    };
  }

  let questions = assignBodies(ordered, candidates);
  questions = applyHierarchy(questions);
  const orphans = orphanBlocks(ordered, candidates);
  const ambiguities = detectAmbiguities(questions);
  return { questions, ambiguities, orphanBlockIds: orphans, usedLlm: false };
}

// --------------------------------------------------------------------- stage 1: numbers
function detectNumbering(ordered: Array<{ page: number; block: IRBlock }>): Candidate[] {
  const candidates: Candidate[] = [];
  ordered.forEach(({ page, block }, position) => {
    const parsed = parseLabel(block.text, false);
    if (parsed === null) return;
    // A label with nothing after it, on a block that is otherwise long prose, is more
    // likely a citation than a question head; require a short prefix.
    if (parsed.display.length > 12) return;
    candidates.push({ label: parsed, page, block, position });
  });
  return candidates;
}

// ---------------------------------------------------------------- stage 3: body assignment
function assignBodies(
  ordered: Array<{ page: number; block: IRBlock }>,
  candidates: Candidate[]
): ExtractedQuestion[] {
  const questions: ExtractedQuestion[] = [];
  candidates.forEach((candidate, index) => {
    const start = candidate.position;
    const end = index + 1 < candidates.length ? candidates[index + 1].position : ordered.length;
    const span = ordered.slice(start, end);

    const headText = candidate.label.remainder;
    const bodyParts: string[] = headText ? [headText] : [];
    const blockIds: string[] = [candidate.block.blockId];
    const content: Array<{ page: number; block: IRBlock }> = [span[0]];
    let marksFromColumn: number | null = null;

    for (const { page, block } of span.slice(1)) {
      const marksMarker = block.text.match(MARKS_ONLY);
      if (marksMarker) {
        marksFromColumn = parseFloat(marksMarker[1]);
        continue;
      }
      if (SECTION_HEADER.test(block.text)) continue;
      bodyParts.push(block.text);
      blockIds.push(block.blockId);
      content.push({ page, block });
    }
    const text = bodyParts.filter(Boolean).join(" ").trim();

    const regions = regionsFor(content);
    const confidences = content.map(({ block }) => block.confidence);
    if (confidences.length === 0) confidences.push(1.0);
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

    questions.push({
      questionId: `q-${candidate.label.normalized}-${index}`,
      displayNumber: candidate.label.display.replace(/[\s.:]+$/, ""),
      normalizedNumber: candidate.label.normalized,
      parentNumber: null,
      text,
      pages: [...new Set(content.map((c) => c.page))].sort((a, b) => a - b),
      regions,
      orderIndex: index,
      optional: isOptional(text),
      maxMarks: detectMarks(text) ?? marksFromColumn,
      confidence: Math.round(Math.min(1, avgConfidence) * 10000) / 10000,
      blockIds,
    });
  });
  return questions;
}

/** One region per page — a question crossing a page boundary gets a region on each. */
function regionsFor(span: Array<{ page: number; block: IRBlock }>): Region[] {
  const byPage = new Map<number, IRBlock["bbox"][]>();
  for (const { page, block } of span) {
    const list = byPage.get(page) ?? [];
    list.push(block.bbox);
    byPage.set(page, list);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, boxes]) => ({ page, bbox: unionAll(boxes) }));
}

// ------------------------------------------------------------------- stage 2: hierarchy
function rstripChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

/**
 * `11(a)` and `11(b)` are separate rows sharing a parent of `11`; `(i)` nests deeper.
 * Bare `(a)` / `(i)` labels inherit the nearest preceding numeric stem, so a paper
 * that prints `11.` then `(a)` on the next line still produces `11.a`.
 */
function applyHierarchy(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const out: ExtractedQuestion[] = [];
  let stemTop: string | null = null;
  let stemSub: string | null = null;
  const known = new Set<string>();

  for (const question of questions) {
    const parts = question.normalizedNumber.split(".");
    let normalized: string;
    if (/^\d+$/.test(parts[0])) {
      stemTop = parts[0];
      stemSub = parts.length > 1 ? parts[1] : null;
      normalized = question.normalizedNumber;
    } else if (stemTop !== null) {
      const isRoman = parts[0].length > 0 && [...parts[0]].every((ch) => "ivx".includes(ch));
      if (isRoman && stemSub) {
        normalized = [stemTop, stemSub, ...parts].join(".");
      } else {
        // `a) i)` arrives as `a.i`: the letter re-bases the sub stem and every deeper
        // level is kept. Taking parts[0] alone silently drops the roman.
        normalized = [stemTop, ...parts].join(".");
        stemSub = parts[0];
      }
    } else {
      normalized = question.normalizedNumber;
    }

    while (known.has(normalized)) {
      // U7 — use a numeric suffix, not an apostrophe.
      const base = rstripChars(rstripChars(normalized, "0123456789"), ".");
      let suffixNum = 2;
      while (known.has(`${base}.${suffixNum}`)) suffixNum++;
      normalized = `${base}.${suffixNum}`;
    }
    known.add(normalized);

    out.push({
      ...question,
      normalizedNumber: normalized,
      parentNumber: parentOf(normalized),
      questionId: `q-${normalized}`,
    });
  }
  return out;
}

function orphanBlocks(
  ordered: Array<{ page: number; block: IRBlock }>,
  candidates: Candidate[]
): string[] {
  if (candidates.length === 0) return ordered.map((o) => o.block.blockId);
  const first = candidates[0].position;
  return ordered.slice(0, first).map((o) => o.block.blockId);
}

// ------------------------------------------------------------ stage 4: ambiguity checks
/** Deterministic checks that decide whether a model is needed at all. */
export function detectAmbiguities(questions: ExtractedQuestion[]): string[] {
  const issues: string[] = [];
  const tops = questions
    .map((q) => q.normalizedNumber.split(".")[0])
    .filter((part) => /^\d+$/.test(part))
    .map((part) => parseInt(part, 10));
  const uniqueTops = [...new Set(tops)].sort((a, b) => a - b);

  const sortedTops = [...tops].sort((a, b) => a - b);
  if (!tops.every((v, i) => v === sortedTops[i])) {
    issues.push("non_monotonic_numbering");
  }
  for (let i = 0; i < uniqueTops.length - 1; i++) {
    const previous = uniqueTops[i];
    const current = uniqueTops[i + 1];
    if (current - previous > 1) issues.push(`gap_between_${previous}_and_${current}`);
  }

  // A parent that prints only `Q2.` and leaves the wording to `a)` / `b)` is the normal
  // shape of a sectioned paper, not an ambiguity worth spending a model call on. Match
  // on prefix, not on parentNumber: a paper that prints `Q12.` then `b) i)` produces
  // `12.b.i` with no intervening `12.b` row, so `12` is an ancestor without ever being
  // anyone's direct parent.
  const numbers = questions.map((q) => q.normalizedNumber);
  for (const question of questions) {
    const stem = `${question.normalizedNumber}.`;
    const hasChildren = numbers.some((n) => n.startsWith(stem));
    if (!question.text.trim() && !hasChildren) {
      issues.push(`empty_body:${question.normalizedNumber}`);
    }
    if (question.confidence < settings.questionConfidenceThreshold) {
      issues.push(`low_confidence:${question.normalizedNumber}`);
    }
  }
  return issues;
}

// ----------------------------------------------------------------- stages 5 & 6: extras
function isOptional(text: string): boolean {
  return OPTIONAL_PATTERNS.some((pattern) => pattern.test(text));
}

function detectMarks(text: string): number | null {
  for (const pattern of MARKS_PATTERNS) {
    const match = text.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  return null;
}
