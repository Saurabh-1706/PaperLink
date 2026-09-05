import { describe, expect, it } from "vitest";
import { assessmentSummary, gradeMapping, HELD_METHODS, PROVISIONAL } from "./engine";
import type { Mapping } from "../mapping_engine/types";
import type { ExtractedAnswer } from "../answer_pipeline/types";
import type { ExtractedQuestion } from "../question_pipeline/types";
import type { Grade } from "./types";

function question(overrides: Partial<ExtractedQuestion> = {}): ExtractedQuestion {
  return {
    questionId: "q-1",
    displayNumber: "1",
    normalizedNumber: "1",
    parentNumber: null,
    text: "Explain photosynthesis in plants.",
    pages: [1],
    regions: [],
    orderIndex: 0,
    optional: false,
    maxMarks: 5,
    confidence: 0.9,
    blockIds: [],
    ...overrides,
  };
}

function answer(overrides: Partial<ExtractedAnswer> = {}): ExtractedAnswer {
  return {
    answerId: "a-1",
    rawText: "Plants use sunlight to make food via photosynthesis in chloroplast.",
    normalizedText: "plants use sunlight to make food via photosynthesis in chloroplast.",
    detectedLabel: "1",
    detectedLabelDisplay: "1",
    pageNumbers: [1],
    regions: [],
    confidence: 0.9,
    extractionMethod: "ocr",
    isContinuationOf: null,
    blockIds: [],
    ...overrides,
  };
}

function mapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    questionId: "q-1",
    answerId: "a-1",
    mappingType: "direct",
    confidence: 0.9,
    reviewStatus: "auto_accepted",
    regions: [],
    evidence: {
      stage: "label",
      labelScore: 1,
      spatialScore: 0,
      semanticScore: 0,
      combinedScore: 0.97,
      runnerUpScore: null,
      runnerUpQuestionId: null,
      llmVerdict: null,
      notes: [],
    },
    ...overrides,
  };
}

describe("gradeMapping — needs_review mappings are provisional, not scored outright", () => {
  it("grades a needs_review mapping as provisional, prefixing the feedback", async () => {
    const q = question();
    const a = answer();
    const m = mapping({ reviewStatus: "needs_review" });
    const grade = await gradeMapping(m, new Map([[q.questionId, q]]), new Map([[a.answerId, a]]));
    expect(grade?.method).toBe(PROVISIONAL);
    expect(grade?.skippedReason).toBe("mapping_needs_review");
    expect(grade?.feedback.startsWith("[PROVISIONAL")).toBe(true);
  });

  it("skips (score 0) a needs_review mapping with no usable answer text", async () => {
    const q = question();
    const a = answer({ normalizedText: "   " });
    const m = mapping({ reviewStatus: "needs_review" });
    const grade = await gradeMapping(m, new Map([[q.questionId, q]]), new Map([[a.answerId, a]]));
    expect(grade?.method).toBe("skipped");
    expect(grade?.score).toBe(0);
  });

  it("grades a normal auto_accepted mapping deterministically", async () => {
    const q = question();
    const a = answer();
    const m = mapping();
    const grade = await gradeMapping(m, new Map([[q.questionId, q]]), new Map([[a.answerId, a]]));
    expect(grade?.method).toBe("deterministic");
  });

  it("returns null for an unmatched extra answer (no question)", async () => {
    const grade = await gradeMapping(mapping({ questionId: null }), new Map(), new Map());
    expect(grade).toBeNull();
  });

  it("scores an unanswered question as 0 with a deterministic method", async () => {
    const q = question();
    const m = mapping({ mappingType: "unanswered", answerId: null, reviewStatus: "needs_review" });
    const grade = await gradeMapping(m, new Map([[q.questionId, q]]), new Map());
    expect(grade?.method).toBe("deterministic");
    expect(grade?.score).toBe(0);
  });
});

describe("assessmentSummary — the CLAUDE.md invariant", () => {
  const grades: Array<Pick<Grade, "method" | "score" | "maxScore">> = [
    { method: "deterministic", score: 4, maxScore: 5 },
    { method: "llm", score: 3, maxScore: 5 },
    { method: PROVISIONAL, score: 5, maxScore: 5 }, // must NOT count toward total_score
    { method: "skipped", score: 0, maxScore: 5 }, // must NOT count toward total_score
  ];

  it("excludes provisional and skipped grades from graded_count/total_score/percentage", () => {
    const summary = assessmentSummary(grades);
    expect(summary.gradedCount).toBe(2);
    expect(summary.totalScore).toBe(7); // 4 + 3, NOT +5 from the provisional grade
    expect(summary.maxScore).toBe(10);
    expect(summary.percentage).toBe(70);
  });

  it("reports provisional grades separately, not folded into the total", () => {
    const summary = assessmentSummary(grades);
    expect(summary.provisionalCount).toBe(1);
    expect(summary.provisionalScore).toBe(5);
    expect(summary.heldForReview).toBe(2); // provisional + skipped
  });

  it("HELD_METHODS contains exactly skipped and provisional", () => {
    expect(HELD_METHODS.has("skipped")).toBe(true);
    expect(HELD_METHODS.has(PROVISIONAL)).toBe(true);
    expect(HELD_METHODS.has("deterministic")).toBe(false);
    expect(HELD_METHODS.has("llm")).toBe(false);
  });

  it("returns 0% (not NaN) when there is nothing scored yet", () => {
    const summary = assessmentSummary([]);
    expect(summary.percentage).toBe(0);
    expect(summary.totalScore).toBe(0);
  });
});
