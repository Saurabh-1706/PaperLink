/**
 * Mapping stages 1, 2 and 4 as independent, individually testable scorers. Port of
 * backend/app/modules/mapping_engine/stages.py. Each stage can be disabled from the
 * engine so its contribution is measurable.
 */
import { extractTopInt, sortKey, compareSortKeys } from "../question_pipeline/labels";
import { semanticScore } from "./similarity";
import type { ExtractedQuestion } from "../question_pipeline/types";
import type { ExtractedAnswer } from "../answer_pipeline/types";

export const LABEL_EXACT = 1.0;
export const LABEL_PARENT = 0.55;
// Below this, a stage's score carries no real information (rather than "mild
// disagreement") — see `combine()`.
export const WEAK_SIGNAL = 0.05;

export interface StageWeights {
  label: number;
  spatial: number;
  semantic: number;
}

export const DEFAULT_WEIGHTS: StageWeights = {
  label: 0.55,
  spatial: 0.2, // U4 — reduced from 0.25 to give semantic more influence
  semantic: 0.25, // U4 — raised from 0.20; vision-corrected text is cleaner
};

// --------------------------------------------------------------- stage 1: explicit label
/** Where a student wrote `11(a)`, that is near-certain evidence and costs nothing. */
export function labelScore(question: ExtractedQuestion, answer: ExtractedAnswer): number {
  if (!answer.detectedLabel) return 0.0;
  if (answer.detectedLabel === question.normalizedNumber) return LABEL_EXACT;
  // A student writing only "11" against question "11(a)" is weak but real evidence.
  if (question.normalizedNumber.startsWith(`${answer.detectedLabel}.`)) return LABEL_PARENT;
  if (answer.detectedLabel.startsWith(`${question.normalizedNumber}.`)) return LABEL_PARENT;
  return 0.0;
}

// U2 — Question-number offset resolver. Detects the integer offset between
// answer-sheet numbering and question-paper numbering from the first confident
// direct match, then applies it to all remaining label comparisons.
export function detectLabelOffset(questions: ExtractedQuestion[], answers: ExtractedAnswer[]): number {
  // One vote per top-level question number, not one per row: a question with several
  // sub-parts (11.a, 11.b, 11.c) must not get 3x the voting power of a question with
  // none, or a heavily sub-divided paper skews the detected offset away from the true value.
  const uniqueQTops = [
    ...new Set(
      questions
        .map((q) => extractTopInt(q.normalizedNumber))
        .filter((top): top is number => top !== null)
    ),
  ].sort((a, b) => a - b);

  const offsets = new Map<number, number>();
  for (const answer of answers) {
    if (!answer.detectedLabel) continue;
    const aTop = extractTopInt(answer.detectedLabel);
    if (aTop === null) continue;
    for (const qTop of uniqueQTops) {
      const diff = aTop - qTop;
      offsets.set(diff, (offsets.get(diff) ?? 0) + 1);
    }
  }
  if (offsets.size === 0) return 0;
  // Return the most frequently observed offset.
  let best = 0;
  let bestCount = -1;
  for (const [diff, count] of offsets) {
    if (count > bestCount) {
      best = diff;
      bestCount = count;
    }
  }
  return best;
}

/** `labelScore` that also tries the offset-adjusted label before giving up. */
export function labelScoreWithOffset(
  question: ExtractedQuestion,
  answer: ExtractedAnswer,
  offset: number
): number {
  const base = labelScore(question, answer);
  if (base > 0.0 || offset === 0 || !answer.detectedLabel) return base;
  const aTop = extractTopInt(answer.detectedLabel);
  const qTop = extractTopInt(question.normalizedNumber);
  if (aTop === null || qTop === null) return 0.0;
  if (aTop - qTop !== offset) return 0.0;
  // Sub-part must also match when present.
  const aParts = answer.detectedLabel.split(".").slice(1);
  const qParts = question.normalizedNumber.split(".").slice(1);
  if (aParts.length === qParts.length && aParts.every((p, i) => p === qParts[i])) return LABEL_EXACT;
  if (aParts.length === 0 && qParts.length > 0) return LABEL_PARENT;
  return 0.0;
}

// --------------------------------------------------------- stage 2: spatial / page prior
/**
 * Most sheets are near-ordered, so preserving monotonic order is informative and
 * free. This is what rescues unlabelled answers: position beats semantics on short
 * handwriting.
 */
export function spatialScore(
  question: ExtractedQuestion,
  answer: ExtractedAnswer,
  questionRank: Map<string, number>,
  answerRank: Map<string, number>
): number {
  const q = questionRank.get(question.questionId);
  const a = answerRank.get(answer.answerId);
  if (q === undefined || a === undefined) return 0.0;
  return Math.round(Math.max(0.0, 1.0 - Math.abs(q - a)) * 10000) / 10000;
}

/** Map an ordered list of ids onto evenly spaced positions in [0, 1]. */
export function buildRanks(items: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  if (items.length === 0) return ranks;
  if (items.length === 1) {
    ranks.set(items[0], 0.5);
    return ranks;
  }
  items.forEach((item, index) => ranks.set(item, index / (items.length - 1)));
  return ranks;
}

export function questionOrder(questions: ExtractedQuestion[]): string[] {
  return [...questions]
    .sort((a, b) => compareSortKeys(sortKey(a.normalizedNumber), sortKey(b.normalizedNumber)))
    .map((q) => q.questionId);
}

export function answerOrder(answers: ExtractedAnswer[]): string[] {
  function key(answer: ExtractedAnswer): [number, number] {
    const region = answer.regions[0];
    // An answer with no page/bbox has no real position — defaulting it to (0, 0)
    // would sort it ahead of every properly-positioned answer and shift every rank
    // after it, corrupting the spatial signal for the whole page. Push it to the end
    // instead, where it can't disturb anyone else's ordering.
    const page = answer.pageNumbers.length > 0 ? answer.pageNumbers[0] : Infinity;
    const y = region ? region.bbox.y1 : Infinity;
    return [page, y];
  }
  return [...answers]
    .sort((a, b) => {
      const [pa, ya] = key(a);
      const [pb, yb] = key(b);
      return pa !== pb ? pa - pb : ya - yb;
    })
    .map((a) => a.answerId);
}

// ------------------------------------------------------------- stage 4: semantic overlap
export function semanticStageScore(question: ExtractedQuestion, answer: ExtractedAnswer): number {
  return semanticScore(question.text, answer.normalizedText);
}

/** An exact label is decisive on its own; otherwise the weighted blend decides. */
export function combine(
  label: number,
  spatial: number,
  semantic: number,
  weights: StageWeights = DEFAULT_WEIGHTS
): number {
  if (label >= LABEL_EXACT) return 0.97;
  let combined = weights.label * label + weights.spatial * spatial + weights.semantic * semantic;
  // Without a label the two remaining signals must carry the full range on their own.
  if (label === 0.0) {
    if (spatial <= WEAK_SIGNAL && semantic > WEAK_SIGNAL) {
      // No usable positional evidence at all — an answer written out of the expected
      // order — so a strong text match must not be diluted by spatial's absent
      // weight. A plain weighted average with spatial pinned at 0 caps out around
      // 0.38-0.47 even for a perfect semantic match, below `review_threshold` (0.45):
      // legitimate out-of-order answers were silently dropped as unanswered.
      combined = semantic * 0.85;
    } else {
      const denominator = weights.spatial + weights.semantic;
      combined = (weights.spatial * spatial + weights.semantic * semantic) / denominator;
      combined *= 0.85; // unlabelled matches are never as certain as labelled ones
    }
  }
  return Math.round(Math.min(0.99, Math.max(0.0, combined)) * 10000) / 10000;
}
