/**
 * Grading: deterministic rules first, LLM rubric scoring only for open-ended
 * answers. Port of backend/app/modules/grading/engine.py.
 *
 * A mapping in `needs_review` is never (finally) graded — a confidently wrong mark
 * is worse than an unscored one. It gets a `provisional` grade instead, so the
 * teacher sees a starting point; `assessmentSummary` is what keeps that out of the
 * reported total (CLAUDE.md: "needs_review mappings never score... excluded from
 * graded_count, total_score and percentage until a human confirms the mapping").
 */
import { tokenize } from "../mapping_engine/similarity";
import type { Mapping } from "../mapping_engine/types";
import type { ExtractedAnswer } from "../answer_pipeline/types";
import type { ExtractedQuestion } from "../question_pipeline/types";
import type { CriterionScore, Grade, Rubric } from "./types";

export const DEFAULT_MAX_MARKS = 1.0;

// A grade carrying this method came from a mapping nobody has confirmed. It is
// shown to the teacher as a starting point and is never part of the reported score.
export const PROVISIONAL = "provisional";
export const HELD_METHODS: ReadonlySet<string> = new Set(["skipped", PROVISIONAL]);

export type GradingLlm = (
  questionText: string,
  answerText: string,
  maxMarks: number,
  criteria: Array<[string, number]>
) => Promise<{
  score: number;
  feedback: string;
  breakdown: Array<{ name: string; awarded: number; maxMarks: number; rationale: string }>;
} | null>;

export async function gradeAssessment(
  mappings: Mapping[],
  questions: Map<string, ExtractedQuestion>,
  answers: Map<string, ExtractedAnswer>,
  rubrics: Map<string, Rubric> = new Map(),
  llm?: GradingLlm
): Promise<Grade[]> {
  const grades: Grade[] = [];
  for (const mapping of mappings) {
    const grade = await gradeMapping(mapping, questions, answers, rubrics.get(mapping.questionId ?? ""), llm);
    if (grade !== null) grades.push(grade);
  }
  return grades;
}

export async function gradeMapping(
  mapping: Mapping,
  questions: Map<string, ExtractedQuestion>,
  answers: Map<string, ExtractedAnswer>,
  rubric?: Rubric,
  llm?: GradingLlm
): Promise<Grade | null> {
  if (mapping.questionId === null) return null; // an unmatched extra answer scores nothing
  const question = questions.get(mapping.questionId);
  if (question === undefined) return null;
  const maxMarks = question.maxMarks || DEFAULT_MAX_MARKS;

  // U5 — grade needs_review mappings as provisional instead of skipping entirely.
  // A provisional grade shows the teacher a starting score with a clear warning.
  if (mapping.reviewStatus === "needs_review" && mapping.mappingType !== "unanswered") {
    const answer = mapping.answerId ? answers.get(mapping.answerId) : undefined;
    if (answer === undefined || !answer.normalizedText.trim()) {
      return {
        questionId: mapping.questionId,
        answerId: mapping.answerId,
        score: 0.0,
        maxScore: maxMarks,
        breakdown: [],
        method: "skipped",
        skippedReason: "mapping_needs_review",
        feedback: "Held for review: the answer assigned to this question is uncertain.",
      };
    }
    let grade: Grade | null = null;
    if (llm) grade = await llmGrade(question, answer, rubric, maxMarks, llm);
    if (grade === null) grade = fallbackGrade(question, answer, maxMarks);
    return {
      ...grade,
      method: PROVISIONAL,
      // Carries the same reason a skipped grade would, so a caller can say *why*
      // the score is being withheld without special-casing the two methods.
      skippedReason: "mapping_needs_review",
      feedback: `[PROVISIONAL — mapping unconfirmed] ${grade.feedback}`,
    };
  }

  const answer = mapping.answerId ? answers.get(mapping.answerId) : undefined;
  if (mapping.mappingType === "unanswered" || answer === undefined || !answer.normalizedText.trim()) {
    return {
      questionId: mapping.questionId,
      answerId: mapping.answerId,
      score: 0.0,
      maxScore: maxMarks,
      breakdown: [],
      method: "deterministic",
      skippedReason: null,
      feedback: "No answer was found for this question.",
    };
  }

  if (rubric && rubric.criteria.length > 0 && rubric.criteria.some((c) => c.keywords.length > 0)) {
    return keywordGrade(question, answer, rubric, maxMarks);
  }

  if (llm) {
    const graded = await llmGrade(question, answer, rubric, maxMarks, llm);
    if (graded !== null) return graded;
  }

  return fallbackGrade(question, answer, maxMarks);
}

function keywordGrade(question: ExtractedQuestion, answer: ExtractedAnswer, rubric: Rubric, maxMarks: number): Grade {
  const tokens = new Set(tokenize(answer.normalizedText));
  const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0) || 1.0;
  const breakdown: CriterionScore[] = [];
  let score = 0.0;
  for (const criterion of rubric.criteria) {
    const criterionMax = criterion.maxMarks || maxMarks * (criterion.weight / totalWeight);
    const keywords = criterion.keywords.map((k) => k.toLowerCase());
    let hits = 0;
    for (const keyword of keywords) {
      for (const token of tokens) {
        if (keyword.includes(token) || token.includes(keyword)) {
          hits++;
          break;
        }
      }
    }
    const ratio = keywords.length > 0 ? hits / keywords.length : 0.0;
    const awarded = Math.round(criterionMax * ratio * 100) / 100;
    score += awarded;
    breakdown.push({
      name: criterion.name,
      awarded,
      maxMarks: Math.round(criterionMax * 100) / 100,
      rationale: `matched ${hits}/${keywords.length} rubric terms`,
    });
  }
  return {
    questionId: question.questionId,
    answerId: answer.answerId,
    score: Math.round(Math.min(score, maxMarks)),
    maxScore: maxMarks,
    breakdown,
    method: "deterministic",
    skippedReason: null,
    feedback: feedbackFromBreakdown(breakdown),
  };
}

async function llmGrade(
  question: ExtractedQuestion,
  answer: ExtractedAnswer,
  rubric: Rubric | undefined,
  maxMarks: number,
  llm: GradingLlm
): Promise<Grade | null> {
  const criteria: Array<[string, number]> = (rubric?.criteria ?? []).map((c) => [c.name, c.weight]);
  const result = await llm(question.text, answer.normalizedText, maxMarks, criteria);
  if (result === null) return null;
  return {
    questionId: question.questionId,
    answerId: answer.answerId,
    score: Math.round(Math.max(0.0, Math.min(result.score, maxMarks))),
    maxScore: maxMarks,
    breakdown: result.breakdown.map((item) => ({ ...item })),
    method: "llm",
    skippedReason: null,
    feedback: result.feedback,
  };
}

/** Deterministic last resort: coverage of the question's own content words. */
function fallbackGrade(question: ExtractedQuestion, answer: ExtractedAnswer, maxMarks: number): Grade {
  const questionTokens = new Set(tokenize(question.text));
  const answerTokens = new Set(tokenize(answer.normalizedText));
  let intersectionSize = 0;
  for (const t of questionTokens) if (answerTokens.has(t)) intersectionSize++;
  const coverage = questionTokens.size > 0 ? intersectionSize / questionTokens.size : 0.0;
  const score = Math.round(maxMarks * Math.min(1.0, coverage * 1.5));
  return {
    questionId: question.questionId,
    answerId: answer.answerId,
    score,
    maxScore: maxMarks,
    breakdown: [],
    method: "deterministic",
    skippedReason: null,
    feedback:
      "Scored without a rubric or model: the mark reflects overlap with the question's " +
      "key terms and should be confirmed by a teacher.",
  };
}

function feedbackFromBreakdown(breakdown: CriterionScore[]): string {
  const missing = breakdown.filter((item) => item.awarded < item.maxMarks * 0.5).map((item) => item.name);
  if (missing.length === 0) return "All rubric criteria were addressed.";
  return `Weak or missing coverage of: ${missing.join(", ")}.`;
}

export interface AssessmentSummary {
  gradedCount: number;
  heldForReview: number;
  provisionalCount: number;
  provisionalScore: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
}

/**
 * Totals for an assessment. Provisional grades are held, not counted — the split is
 * by *method*, not by presence: `gradedCount`/`totalScore`/`percentage` describe
 * confirmed grades alone, and `provisionalCount` reports the rest separately so a
 * caller can show them without them counting. Takes just the fields it reads (not
 * the full `Grade`) so callers building this from a stored `GradeRow` don't need to
 * fabricate the rest.
 */
export function assessmentSummary(grades: Array<Pick<Grade, "method" | "score" | "maxScore">>): AssessmentSummary {
  const scored = grades.filter((g) => !HELD_METHODS.has(g.method));
  const provisional = grades.filter((g) => g.method === PROVISIONAL);
  const total = scored.reduce((sum, g) => sum + g.score, 0);
  const possible = scored.reduce((sum, g) => sum + g.maxScore, 0);
  return {
    gradedCount: scored.length,
    heldForReview: grades.length - scored.length,
    provisionalCount: provisional.length,
    provisionalScore: Math.round(provisional.reduce((sum, g) => sum + g.score, 0)),
    totalScore: Math.round(total),
    maxScore: Math.round(possible),
    percentage: possible ? Math.round((100 * total) / possible) : 0.0,
  };
}
