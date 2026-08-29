import type { AnswerRegion, GradingSummary, MappedAnswer, Question, RawAnswerBlock } from "@/types";

function normalizeNumber(n: string | null | undefined): string | null {
  if (!n) return null;
  return n.toLowerCase().replace(/[\s.)]/g, "").replace(/^q/, "");
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Vision models occasionally return garbage coordinates (out of [0,1],
 * inverted, or a box covering the whole page when unsure). Clamp into range
 * and drop anything that isn't a plausible answer-sized region rather than
 * rendering a highlight box that's visibly wrong or covers the entire page.
 */
function sanitizeRegions(regions: AnswerRegion[]): AnswerRegion[] {
  return regions
    .map((r) => {
      let { x, y, width, height, page } = r;
      page = Number(page) || 0;
      x = Number(x) || 0;
      y = Number(y) || 0;
      width = Number(width) || 0;
      height = Number(height) || 0;
      // Robustness: If LLM returns percentages (e.g., 10 instead of 0.10), normalize them.
      if (x > 1 || y > 1 || width > 1 || height > 1) {
        x /= 100;
        y /= 100;
        width /= 100;
        height /= 100;
      }
      x = clamp01(x);
      y = clamp01(y);
      width = clamp01(width);
      height = clamp01(height);
      return { ...r, page, x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
    })
    .filter((r) => {
      const area = r.width * r.height;
      // Reject zero-area boxes (nothing to show). We no longer reject full-page
      // boxes because an answer can genuinely span an entire page.
      return area > 0.0005;
    });
}

/**
 * Joins extracted questions with extracted answer blocks by question number.
 * Handles: answers written out of order (matching is by number, not position),
 * unanswered questions (no block matched), unmatched answers (block matched
 * no question), and multi-page answers (blocks pre-merged by number here).
 */
export function buildMappings(
  questions: Question[],
  rawAnswers: RawAnswerBlock[]
): { mappings: MappedAnswer[]; unmatched: MappedAnswer[] } {
  const byNumber = new Map<string, RawAnswerBlock[]>();
  const unmatchedBlocks: RawAnswerBlock[] = [];

  for (const block of rawAnswers) {
    const key = normalizeNumber(block.questionNumberGuess);
    const matchesKnownQuestion = key && questions.some((q) => normalizeNumber(q.number) === key);
    if (!key || !matchesKnownQuestion) {
      unmatchedBlocks.push(block);
      continue;
    }
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key)!.push(block);
  }

  const mappings: MappedAnswer[] = questions
    .sort((a, b) => a.order - b.order)
    .map((q) => {
      const blocks = byNumber.get(normalizeNumber(q.number)!) ?? [];
      if (blocks.length === 0) {
        return { questionId: q.id, questionNumber: q.number, status: "unanswered" as const };
      }
      const text = blocks.map((b) => b.text).join("\n\n");
      const regions = sanitizeRegions(blocks.flatMap((b) => b.regions));
      const confidence = blocks.reduce((s, b) => s + b.confidence, 0) / blocks.length;
      return {
        questionId: q.id,
        questionNumber: q.number,
        status: "answered" as const,
        answerText: text,
        regions,
        confidence,
      };
    });

  const unmatched: MappedAnswer[] = unmatchedBlocks.map((b) => ({
    questionId: null,
    questionNumber: b.questionNumberGuess,
    status: "unmatched" as const,
    answerText: b.text,
    regions: sanitizeRegions(b.regions),
    confidence: b.confidence,
  }));

  return { mappings, unmatched };
}

export function buildSummary(
  questions: Question[],
  mappings: MappedAnswer[],
  unmatched: MappedAnswer[]
): GradingSummary {
  const answered = mappings.filter((m) => m.status === "answered");
  const unanswered = mappings.filter((m) => m.status === "unanswered");
  const graded = answered.filter((m) => typeof m.score === "number" && typeof m.maxScore === "number");
  const totalScore = graded.length ? graded.reduce((s, m) => s + (m.score ?? 0), 0) : null;
  const maxScore = graded.length ? graded.reduce((s, m) => s + (m.maxScore ?? 0), 0) : null;

  return {
    totalQuestions: questions.length,
    answered: answered.length,
    unanswered: unanswered.length,
    unmatched: unmatched.length,
    totalScore,
    maxScore,
  };
}
