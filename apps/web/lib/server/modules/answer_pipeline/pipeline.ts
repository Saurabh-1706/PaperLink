/**
 * Answer pipeline: IR-JSON in, structured answers out. Port of
 * backend/app/modules/answer_pipeline/pipeline.py.
 *
 * Structurally independent of the question pipeline — it never sees questions.
 * Relating the two is the mapping engine's job alone.
 */
import { settings } from "@/lib/server/config";
import type { IRBlock, IRDocument } from "../extraction/types";
import { irPageByNumber } from "../extraction/types";
import type { Region } from "../common";
import { unionAll } from "../common";
import { ANSWER_PREFIX, normalizeParts, parseLabel, romanToInt, type ParsedLabel } from "../question_pipeline/labels";
import type { AnswerPipelineResult, ExtractedAnswer } from "./types";

// Segmentation tuning. These are page-relative, so they survive any page size.
export const GAP_FACTOR = 2.5; // a gap this much larger than the page's line spacing starts a segment
export const MIN_GAP = 0.012;
export const INDENT_SHIFT = 0.08; // a left-margin jump this large is a structural break
// Multiple of the page's typical line spacing that an UNLABELLED line must clear to
// break away from a labelled answer. Deliberately looser than GAP_FACTOR: breaking
// here costs an incomplete answer plus an orphan fragment, while merging costs at
// worst one over-long answer, and students overwhelmingly do label their answers.
export const CONTINUATION_BREAK_FACTOR = 2.0;
export const BOTTOM_OF_PAGE = 0.88; // a segment reaching below this may continue on the next page
export const TOP_OF_PAGE = 0.18;
const CONTINUATION_CUES = /\b(cont(?:d|inued)?\.?|p\.?t\.?o\.?)\b/i;

// U1 — Noise filters applied before segmentation.
// Lone digit/letter: page numbers, MCQ option markers.
const NOISE_LONE = /^\s*[\dA-Za-z]\s*$/;
// Section headers: "SECTION-A", "SECTION - B", "SECTION D" etc.
const NOISE_SECTION = /^\s*SECTION\s*[-–]?\s*[A-Z]\s*$/i;

// U8 — MCQ option letters are answers, not sub-part labels.
// On an answer sheet "8 (B) ..." is the student's chosen option for Q8, not sub-part b
// of Q8. `parseLabel` cannot draw that distinction: it is shared verbatim with the
// question pipeline (labels.ts), where "12 (a)" genuinely IS a sub-part. So the
// distinction is drawn here, on the answer side only, leaving question parsing untouched.
//
// The signal is CASE: option markers are uppercase (A)-(D); printed sub-parts are
// lowercase (a)-(h). These patterns are deliberately case-SENSITIVE — a case-insensitive
// flag would collapse the only thing telling the two apart.
const MCQ_NUMBERED = /^\s*(?:Q(?:ues(?:tion)?)?\s*\.?\s*)?(\d{1,3})\s*[.):]?\s*[([]\s*[A-D]\s*[)\]]/;
const MCQ_BARE = /^\s*[([]\s*[A-D]\s*[)\]]/;

/**
 * `parseLabel` for answer sheets, with MCQ option letters demoted.
 *
 * Two corrections over the shared parser:
 *  - "8 (B) ard m" -> `8`, not `8.b`. The mapping engine looks up the normalised
 *    label directly, so `8.b` sends it hunting for a row that does not exist and the
 *    answer lands in `needs_review` instead of matching Q8.
 *  - "(B) 0.42" -> null. An option letter with no question number attached is not a
 *    label at all; inventing `b` fabricates a top-level-free label that can never
 *    match. Returning null lets segmentation fall back to geometry.
 */
export function parseAnswerLabel(text: string): ParsedLabel | null {
  const parsed = parseLabel(text, true);
  if (parsed === null || parsed.sub === null || parsed.subsub !== null) return parsed;

  let source = text;
  let offset = 0;
  const prefix = text.match(ANSWER_PREFIX);
  if (prefix) {
    offset = prefix[0].length;
    source = text.slice(offset);
  }

  const numbered = source.match(MCQ_NUMBERED);
  if (numbered) {
    const end = offset + numbered[0].length;
    return {
      display: text.slice(0, end).trim(),
      normalized: normalizeParts(numbered[1], null, null),
      level: 0,
      remainder: text.slice(end).trim(),
      top: numbered[1],
      sub: null,
      subsub: null,
    };
  }
  if (parsed.top === null && MCQ_BARE.test(source)) return null;
  return parsed;
}

function isNoiseBlock(block: IRBlock): boolean {
  const text = block.text.trim();
  if (!text) return true;
  if (NOISE_LONE.test(text)) return true;
  if (NOISE_SECTION.test(text)) return true;
  // Short low-confidence fragments (e.g. stray marks, partial words).
  if (text.length < 4 && block.confidence < 0.6) return true;
  return false;
}

interface Segment {
  page: number;
  blocks: IRBlock[];
  labelDisplay: string | null;
  labelNormalized: string | null;
}

/** A bare label's family + ordinal within it, e.g. ("top", 5) for "5.", ("sub", 0) for
 * "a)", ("subsub", 1) for "ii)" — see `bareOrdinal`. */
type Family = "top" | "sub" | "subsub";
type Ordinal = readonly [Family, number];

/**
 * Threaded across the whole sheet — see `classifyLabels`.
 *
 * `value`: family + ordinal of the most recently confirmed REAL label.
 * `lastPoint`: family + ordinal of the most recently confirmed POINT (part of a
 * suppressed run). Without this, a point list that wraps onto a new page starting
 * mid-sequence ("c)" continuing "a), b)" from the page before) has no value == 0 to
 * signal a fresh list start, and would wrongly be read as a real label again. Reset
 * to null whenever a new real top-level label is confirmed — a point list is scoped
 * to the answer it lives inside, not carried into a later, unrelated question.
 */
interface LastRealTop {
  value: Ordinal | null;
  lastPoint: Ordinal | null;
  /**
   * The most recent REAL top-level number, verbatim ("17"), used to qualify a bare
   * sub-label that follows it: a student writes "17 a) ..." once and then just
   * "b)", "c)" underneath, but "b" on its own is not a label the mapping engine can
   * resolve — it has no top-level component for `labelScoreWithOffset` to compare,
   * so it scores 0 and the answer falls through to the weaker geometric stages (or
   * matches nothing at all). Threaded across pages for the same reason `value` is:
   * the run continues past a page break.
   */
  currentTop: string | null;
}

/**
 * Qualify a parsed label with the top-level number in scope. "b)" following "17 a)"
 * is really "17.b"; "a)" following "18." is "18.a". A label that already carries its
 * own top-level component is returned untouched and becomes the new scope.
 */
function qualifyLabel(parsed: ParsedLabel, state: LastRealTop): string {
  if (parsed.top !== null) {
    state.currentTop = parsed.top;
    return parsed.normalized;
  }
  if (parsed.sub !== null && state.currentTop !== null) {
    return normalizeParts(state.currentTop, parsed.sub, parsed.subsub);
  }
  return parsed.normalized;
}

export function extractAnswers(document: IRDocument): AnswerPipelineResult {
  const segments: Segment[] = [];
  // Threaded across every page: a numbered point inside a long answer ("1. ... 2. ...
  // 3. ...") parses exactly like a question label, and without this context each point
  // would start its own segment — shattering one long answer into fragments that
  // compete against unrelated questions in the mapping engine. See `bareOrdinal`.
  const lastRealTop: LastRealTop = { value: null, lastPoint: null, currentTop: null };
  const pages = [...document.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of pages) {
    const blocks = [...page.blocks].sort((a, b) => a.readingOrder - b.readingOrder);
    segments.push(...segmentPage(page.pageNumber, blocks, lastRealTop));
  }

  let answers = segments.map((segment, index) => toAnswer(index, segment, document));
  answers = detectContinuations(answers);
  const lowConfidence = answers
    .filter((a) => a.confidence < settings.answerConfidenceThreshold)
    .map((a) => a.answerId);
  return { answers, lowConfidenceAnswerIds: lowConfidence, usedLlm: false };
}

// ------------------------------------------------------------------ stage 2: segmentation
/**
 * The family + ordinal of a BARE (single-component) label — "5." is ("top", 5),
 * "a)" is ("sub", 0), "ii)" is ("subsub", 2). A compound label like "5.a" or
 * "11(a)(ii)" identifies a specific hierarchical position on its own and is never
 * mistaken for a point list, so it deliberately returns null here rather than
 * picking one component.
 */
function bareOrdinal(parsed: ParsedLabel): Ordinal | null {
  if (parsed.top && !parsed.sub && !parsed.subsub) return ["top", parseInt(parsed.top, 10)];
  if (parsed.sub && !parsed.top && !parsed.subsub) {
    return ["sub", parsed.sub.toLowerCase().charCodeAt(0) - "a".charCodeAt(0)];
  }
  if (parsed.subsub && !parsed.top && !parsed.sub) return ["subsub", romanToInt(parsed.subsub) - 1];
  return null;
}

/**
 * Tell a genuine question-label boundary apart from a point inside the answer above
 * it — numbered, lettered, or roman. See the extended rationale in the original
 * Python source (backend/app/modules/answer_pipeline/pipeline.py::_classify_labels):
 * a suspicious bare label is only demoted if a run of 2+ consecutive candidates in
 * the same family, climbing ordinal+1, ordinal+2, ..., each tightly spaced, actually
 * follows it.
 *
 * Mutates `lastRealTop` in place as it goes, so the caller threads the running state
 * on to the next page.
 */
function classifyLabels(
  parsedLabels: Array<ParsedLabel | null>,
  blocks: IRBlock[],
  lastRealTop: LastRealTop,
  gapThreshold: number
): boolean[] {
  const n = parsedLabels.length;
  const isReal = new Array<boolean>(n).fill(false);
  let index = 0;
  while (index < n) {
    const parsed = parsedLabels[index];
    if (parsed === null) {
      index += 1;
      continue;
    }
    const ordinal = bareOrdinal(parsed);
    const verticalGap = index > 0 ? blocks[index].bbox.y1 - blocks[index - 1].bbox.y2 : 0.0;
    const lastReal = lastRealTop.value;
    const lastPoint = lastRealTop.lastPoint;

    let isSuspect = false;
    let family: Family | undefined;
    let value: number | undefined;
    if (ordinal !== null && lastReal !== null) {
      [family, value] = ordinal;
      if (family === "top") {
        isSuspect = family === lastReal[0] && value < lastReal[1];
      } else {
        const continuesRun = lastPoint !== null && lastPoint[0] === family && lastPoint[1] === value - 1;
        isSuspect = value === 0 || continuesRun;
      }
      isSuspect = isSuspect && verticalGap <= gapThreshold;
    }

    if (!isSuspect) {
      isReal[index] = true;
      if (ordinal !== null) {
        lastRealTop.value = ordinal;
        if (ordinal[0] === "top") lastRealTop.lastPoint = null;
      }
      index += 1;
      continue;
    }

    // Suspicious start — only demote it if a run of consecutive labels actually
    // follows, climbing value, value+1, value+2, ... `family`/`value` are already
    // bound above: isSuspect can only be true when ordinal was not null.
    let expected = (value as number) + 1;
    let cursor = index + 1;
    let runLength = 1;
    while (cursor < n) {
      const candidate = parsedLabels[cursor];
      if (candidate === null) {
        cursor += 1;
        continue;
      }
      const candidateGap = blocks[cursor].bbox.y1 - blocks[cursor - 1].bbox.y2;
      const candidateOrdinal = bareOrdinal(candidate);
      const matches = candidateOrdinal !== null && candidateOrdinal[0] === family && candidateOrdinal[1] === expected;
      if (!matches || candidateGap > gapThreshold) break;
      runLength += 1;
      expected += 1;
      cursor += 1;
    }

    if (runLength >= 2) {
      lastRealTop.lastPoint = [family as Family, expected - 1];
      index = cursor; // a genuine point run: none of these become real labels
      continue;
    }
    isReal[index] = true; // isolated backward step: a real (out-of-order) answer
    lastRealTop.value = ordinal;
    if (family === "top") lastRealTop.lastPoint = null;
    index += 1;
  }
  return isReal;
}

/** Four independent signals: explicit labels, vertical gaps, margin geometry, size. */
function segmentPage(pageNumber: number, rawBlocks: IRBlock[], lastRealTop: LastRealTop): Segment[] {
  // U1 — drop noise before any segmentation logic sees the blocks.
  const blocks = rawBlocks.filter((b) => !isNoiseBlock(b));
  if (blocks.length === 0) return [];

  // Only POSITIVE gaps describe line spacing. Handwriting slants, so successive
  // lines' boxes routinely overlap and yield a negative gap; clamping those to 0 (as
  // this did) feeds phantom zeros into the estimator below. On a handwritten page
  // that was enough to drag the lower quartile to 0.0, collapsing the threshold onto
  // the MIN_GAP floor of 0.012 while real line spacing was ~0.045 — so every wrapped
  // line and bullet point broke into its own answer segment.
  const gaps: number[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const gap = blocks[i + 1].bbox.y1 - blocks[i].bbox.y2;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  // The baseline is the page's ordinary line spacing, taken as the lower quartile of
  // gaps rather than the median: on a page with few long answers the median is
  // already an inter-answer gap, and thresholding off it merges every answer into one.
  const baseline = gaps.length > 0 ? gaps[Math.floor(gaps.length / 4)] : 0.0;
  const gapThreshold = Math.max(MIN_GAP, baseline * GAP_FACTOR);
  // Typical line spacing, used only for the labelled-continuation rule below. The
  // median is the right statistic here (the quartile deliberately under-estimates).
  const lineSpacing = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0.0;

  const rawParsed = blocks.map((block) => parseAnswerLabel(block.text));
  // Only a label short enough to plausibly BE a label (not a long line that merely
  // starts with something label-shaped) is eligible to trigger a new segment on its
  // own; classify those into "real" vs "just a point in the answer above".
  const eligible: Array<ParsedLabel | null> = rawParsed.map((p) => (p !== null && p.display.length <= 14 ? p : null));
  const isRealLabel = classifyLabels(eligible, blocks, lastRealTop, gapThreshold);

  const segments: Segment[] = [];
  let current: Segment = { page: pageNumber, blocks: [], labelDisplay: null, labelNormalized: null };

  blocks.forEach((block, index) => {
    const parsed = rawParsed[index];
    const eligibleParsed = eligible[index];
    const verticalGap = index > 0 ? block.bbox.y1 - blocks[index - 1].bbox.y2 : 0.0;

    let startsHere = false;
    if (eligibleParsed !== null && isRealLabel[index]) {
      startsHere = true;
    } else if (eligibleParsed === null && index > 0) {
      const indentShift = Math.abs(block.bbox.x1 - blocks[index - 1].bbox.x1);
      if (current.labelNormalized !== null) {
        // An unlabelled line that follows a segment which DOES carry a label needs a
        // decisive vertical break to strike out on its own. The label already
        // established whose answer this is, and the alternative reading — that the
        // student started a brand new answer and silently stopped labelling — is the
        // rarer one. Without this, an ordinary wrapped line or "*" bullet inside one
        // answer becomes an orphan segment: it matches no question (having no label)
        // and the answer it was torn from maps to its question incomplete, missing
        // the very sentence being asked for.
        //
        // Indent is deliberately NOT consulted inside a labelled answer. Bullets,
        // wrapped lines and the label's own hanging indent all move the left edge,
        // and OCR x-positions on handwriting are noisy enough to make it meaningless:
        // on the sheet this was traced from, a bullet line continuing "b) ..." was
        // measured half a page-width away from the line it continues.
        startsHere = verticalGap > Math.max(gapThreshold, lineSpacing * CONTINUATION_BREAK_FACTOR);
      } else {
        startsHere = verticalGap > gapThreshold || (verticalGap > MIN_GAP && indentShift > INDENT_SHIFT);
      }
    }

    if (startsHere && current.blocks.length > 0) {
      segments.push(current);
      current = { page: pageNumber, blocks: [], labelDisplay: null, labelNormalized: null };
    }
    if (startsHere && parsed !== null) {
      current.labelDisplay = parsed.display;
      current.labelNormalized = qualifyLabel(parsed, lastRealTop);
    }
    current.blocks.push(block);
  });

  if (current.blocks.length > 0) segments.push(current);
  return segments;
}

function toAnswer(index: number, segment: Segment, document: IRDocument): ExtractedAnswer {
  const rawText = segment.blocks
    .map((b) => b.text)
    .join(" ")
    .trim();
  const page = irPageByNumber(document, segment.page);
  const method = page ? page.extractionMethod : "ocr";
  const confidences = segment.blocks.map((b) => b.confidence);
  if (confidences.length === 0) confidences.push(1.0);
  return {
    answerId: `a-${segment.page}-${index}`,
    rawText,
    normalizedText: normalizeText(rawText),
    detectedLabel: segment.labelNormalized,
    detectedLabelDisplay: segment.labelDisplay,
    pageNumbers: [segment.page],
    regions: [{ page: segment.page, bbox: unionAll(segment.blocks.map((b) => b.bbox)) }],
    confidence: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10000) / 10000,
    extractionMethod: method,
    isContinuationOf: null,
    blockIds: segment.blocks.map((b) => b.blockId),
  };
}

// ---------------------------------------------------------------- stage 3: continuations
/**
 * Link a label-less segment to the segment immediately before it — across a page
 * break, or across an oversized gap on the same page — when nothing suggests it is
 * really a separate answer. See the extended rationale in the Python source
 * (`detect_continuations`): same-page linking additionally requires the student's
 * own explicit continuation cue ("contd.", "P.T.O.", …); cross-page linking has a
 * strong geometric tell (ran to the bottom of one page, resumes at the top of the
 * next) and stays confidence-gated only by that.
 */
export function detectContinuations(answers: ExtractedAnswer[]): ExtractedAnswer[] {
  const out = [...answers];
  const byPage = new Map<number, number[]>();
  out.forEach((answer, index) => {
    const page = answer.pageNumbers[0];
    const list = byPage.get(page) ?? [];
    list.push(index);
    byPage.set(page, list);
  });

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  for (const page of pages) {
    const indices = byPage.get(page)!;

    // Same-page: a label-less segment may continue the one right before it.
    for (let position = 1; position < indices.length; position++) {
      const thisIndex = indices[position];
      const candidate = out[thisIndex];
      if (candidate.detectedLabel) continue;
      const previous = out[indices[position - 1]];
      const indentShift = Math.abs(candidate.regions[0].bbox.x1 - previous.regions[previous.regions.length - 1].bbox.x1);
      if (indentShift > INDENT_SHIFT) continue;
      if (!CONTINUATION_CUES.test(previous.rawText.slice(-40))) continue;
      out[thisIndex] = {
        ...candidate,
        isContinuationOf: previous.answerId,
        confidence: Math.round(Math.min(1, candidate.confidence + 0.05) * 10000) / 10000,
      };
    }

    // Cross-page: the first segment of a page may continue the last of the previous.
    const firstIndex = indices[0];
    const candidate = out[firstIndex];
    if (candidate.detectedLabel || !byPage.has(page - 1)) continue;
    const previousIndices = byPage.get(page - 1)!;
    const previousIndex = previousIndices[previousIndices.length - 1];
    const previous = out[previousIndex];
    if (previous.regions[previous.regions.length - 1].bbox.y2 < BOTTOM_OF_PAGE) continue;
    if (candidate.regions[0].bbox.y1 > TOP_OF_PAGE) continue;
    const cue = CONTINUATION_CUES.test(previous.rawText.slice(-40));
    out[firstIndex] = {
      ...candidate,
      isContinuationOf: previous.answerId,
      confidence: Math.round(Math.min(1, candidate.confidence + (cue ? 0.05 : 0.0)) * 10000) / 10000,
    };
  }
  return out;
}

/** Fold continuation segments into their parent so a two-page answer competes as a
 * single candidate in the mapping solve, not two. */
export function mergeContinuations(answers: ExtractedAnswer[]): ExtractedAnswer[] {
  const byId = new Map(answers.map((a) => [a.answerId, a]));
  const children = new Map<string, ExtractedAnswer[]>();
  for (const answer of answers) {
    if (answer.isContinuationOf && byId.has(answer.isContinuationOf)) {
      const list = children.get(answer.isContinuationOf) ?? [];
      list.push(answer);
      children.set(answer.isContinuationOf, list);
    }
  }

  const merged: ExtractedAnswer[] = [];
  const consumed = new Set<string>();
  for (const answer of answers) {
    if (consumed.has(answer.answerId) || (answer.isContinuationOf && byId.has(answer.isContinuationOf))) continue;
    const chain = [answer];
    let cursor = answer.answerId;
    while (children.has(cursor)) {
      const follow = children.get(cursor)![0];
      chain.push(follow);
      consumed.add(follow.answerId);
      cursor = follow.answerId;
    }
    if (chain.length === 1) {
      merged.push(answer);
      continue;
    }
    const raw = chain
      .map((item) => item.rawText)
      .join(" ")
      .trim();
    const regions: Region[] = chain.flatMap((item) => item.regions);
    merged.push({
      ...answer,
      rawText: raw,
      normalizedText: normalizeText(raw),
      regions,
      pageNumbers: [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b),
      confidence: Math.round(Math.min(...chain.map((item) => item.confidence)) * 10000) / 10000,
      blockIds: chain.flatMap((item) => item.blockIds),
    });
  }
  return merged;
}

// ----------------------------------------------------------------- stage 5: normalisation
/** `rawText` is preserved verbatim; this is what similarity consumes. */
export function normalizeText(text: string): string {
  let normalized = text.normalize("NFKC");
  normalized = normalized.replace(/’/g, "'").replace(/‘/g, "'");
  normalized = normalized.replace(/“/g, '"').replace(/”/g, '"');
  normalized = normalized.replace(/[‐-―]/g, "-");
  normalized = normalized.replace(/\s+/g, " ");
  return normalized.trim();
}
