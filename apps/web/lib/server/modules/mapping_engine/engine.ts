/**
 * The mapping engine — the core deliverable. Port of
 * backend/app/modules/mapping_engine/engine.py.
 *
 * Stages 1-5 build a question x answer score matrix; stage 6 solves it once; stage
 * 7 turns the solution into outcome states. Generic LLM prompting is not
 * responsible for mapping: the LLM sees only the ambiguous band, with 2-3
 * candidates, injected as a `validate` callback rather than imported directly —
 * that keeps this module callable with no network access in tests.
 */
import { settings } from "@/lib/server/config";
import { mergeContinuations } from "../answer_pipeline/pipeline";
import type { ExtractedAnswer } from "../answer_pipeline/types";
import type { ExtractedQuestion } from "../question_pipeline/types";
import { solve } from "./assignment";
import * as stages from "./stages";
import { DEFAULT_WEIGHTS, detectLabelOffset, labelScoreWithOffset, type StageWeights } from "./stages";
import type { Mapping, MappingEvidence, MappingResult } from "./types";

const LLM_BOOST = 0.12;

export interface MappingConfig {
  useLabels: boolean;
  useSpatial: boolean;
  useSemantic: boolean;
  useLlm: boolean;
  acceptThreshold: number;
  reviewThreshold: number;
  ambiguousMargin: number;
  weights: StageWeights;
}

export function defaultMappingConfig(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    useLabels: true,
    useSpatial: true,
    useSemantic: true,
    useLlm: true,
    acceptThreshold: settings.mappingAcceptThreshold,
    reviewThreshold: settings.mappingReviewThreshold,
    ambiguousMargin: settings.mappingAmbiguousMargin,
    weights: DEFAULT_WEIGHTS,
    ...overrides,
  };
}

export type MappingValidator = (
  questionText: string,
  candidates: Array<{ answerId: string; text: string }>
) => Promise<{ answerId: string | null; reason?: string } | null>;

export async function mapAnswers(
  questions: ExtractedQuestion[],
  answers: ExtractedAnswer[],
  config: MappingConfig = defaultMappingConfig(),
  validate?: MappingValidator
): Promise<MappingResult> {
  // Continuation segments are merged before the solve, so a two-page answer competes
  // as one candidate rather than two.
  const logicalAnswers = mergeContinuations(answers);

  if (questions.length === 0) {
    return { mappings: logicalAnswers.map(unmatched), usedLlm: false };
  }

  const questionRank = stages.buildRanks(stages.questionOrder(questions));
  const answerRank = stages.buildRanks(stages.answerOrder(logicalAnswers));

  // U2 — detect numbering offset once before building the matrix.
  const labelOffset = detectLabelOffset(questions, logicalAnswers);

  const matrix: number[][] = [];
  const detail: MappingEvidence[][] = [];
  for (const question of questions) {
    const row: number[] = [];
    const rowDetail: MappingEvidence[] = [];
    for (const answer of logicalAnswers) {
      const label = config.useLabels ? labelScoreWithOffset(question, answer, labelOffset) : 0.0;
      const spatial = config.useSpatial ? stages.spatialScore(question, answer, questionRank, answerRank) : 0.0;
      const semantic = config.useSemantic ? stages.semanticStageScore(question, answer) : 0.0;
      const combined = stages.combine(label, spatial, semantic, config.weights);
      row.push(combined);
      rowDetail.push({
        stage: dominantStage(label, spatial, semantic),
        labelScore: label,
        spatialScore: spatial,
        semanticScore: semantic,
        combinedScore: combined,
        runnerUpScore: null,
        runnerUpQuestionId: null,
        llmVerdict: null,
        notes: [],
      });
    }
    matrix.push(row);
    detail.push(rowDetail);
  }

  let usedLlm = false;
  if (config.useLlm && validate) {
    usedLlm = await llmValidateAmbiguous(questions, logicalAnswers, matrix, detail, config, validate);
  }

  const pairs = solve(matrix, config.reviewThreshold);
  return finalize(questions, logicalAnswers, matrix, detail, pairs, config, usedLlm);
}

// ------------------------------------------------------------ stage 5: bounded LLM check
/** Called only where the top-1 score is not decisively above the runner-up. */
async function llmValidateAmbiguous(
  questions: ExtractedQuestion[],
  answers: ExtractedAnswer[],
  matrix: number[][],
  detail: MappingEvidence[][],
  config: MappingConfig,
  validate: MappingValidator
): Promise<boolean> {
  let used = false;
  for (let row = 0; row < questions.length; row++) {
    const question = questions[row];
    const scores: Array<[number, number]> = answers.map((_, column) => [matrix[row][column], column]);
    scores.sort((a, b) => (b[0] !== a[0] ? b[0] - a[0] : b[1] - a[1]));
    if (scores.length < 2) continue;

    const [top, runnerUp] = scores;
    if (top[0] <= 0.0) continue;
    if (top[0] >= config.acceptThreshold && top[0] - runnerUp[0] > config.ambiguousMargin) continue; // decisive
    if (top[0] < config.reviewThreshold) continue; // nothing plausible enough to be worth a call

    const candidateColumns = scores.slice(0, 3).map(([, column]) => column).filter((column) => matrix[row][column] > 0);
    const verdict = await validate(
      `${question.displayNumber} ${question.text}`,
      candidateColumns.map((column) => ({
        answerId: answers[column].answerId,
        text: answers[column].normalizedText.slice(0, 800),
      }))
    );
    used = true;
    if (!verdict) continue;
    const chosen = verdict.answerId;
    for (const column of candidateColumns) {
      const evidence = detail[row][column];
      if (answers[column].answerId === chosen) {
        matrix[row][column] = Math.min(0.98, matrix[row][column] + LLM_BOOST);
        detail[row][column] = {
          ...evidence,
          llmVerdict: "selected",
          combinedScore: matrix[row][column],
          notes: [...evidence.notes, (verdict.reason ?? "").slice(0, 200)],
        };
      } else {
        detail[row][column] = { ...evidence, llmVerdict: "rejected" };
      }
    }
  }
  return used;
}

// --------------------------------------------------------------- stage 7: outcome states
function finalize(
  questions: ExtractedQuestion[],
  answers: ExtractedAnswer[],
  matrix: number[][],
  detail: MappingEvidence[][],
  pairs: Array<[number, number]>,
  config: MappingConfig,
  usedLlm: boolean
): MappingResult {
  const mappings: Mapping[] = [];
  const matchedRows = new Set<number>();
  const matchedColumns = new Set<number>();

  for (const [row, column] of pairs) {
    const question = questions[row];
    const answer = answers[column];
    const score = matrix[row][column];
    // max() over (score, question_id) tuples, default (0.0, null) — matches Python's
    // tuple comparison: ties broken by the lexicographically greater question id.
    let runnerUp: [number, string | null] = [0.0, null];
    for (let other = 0; other < questions.length; other++) {
      if (other === row) continue;
      const candidateScore = matrix[other][column];
      const candidateId = questions[other].questionId;
      if (
        candidateScore > runnerUp[0] ||
        (candidateScore === runnerUp[0] && (runnerUp[1] === null || candidateId > runnerUp[1]))
      ) {
        runnerUp = [candidateScore, candidateId];
      }
    }
    const evidence: MappingEvidence = {
      ...detail[row][column],
      runnerUpScore: runnerUp[0],
      runnerUpQuestionId: runnerUp[1],
    };

    matchedRows.add(row);
    matchedColumns.add(column);
    mappings.push({
      questionId: question.questionId,
      answerId: answer.answerId,
      mappingType: mappingType(evidence),
      confidence: score,
      reviewStatus: score >= config.acceptThreshold ? "auto_accepted" : "needs_review",
      regions: [...answer.regions],
      evidence,
    });
  }

  // Row -> the question that won each matched column, so a losing sibling can be told
  // who its answer went to instead of just looking blank.
  const columnWinner = new Map<number, ExtractedQuestion>();
  for (const [row, column] of pairs) columnWinner.set(column, questions[row]);

  questions.forEach((question, row) => {
    if (matchedRows.has(row)) return;
    let notes = ["no answer assigned"];
    let reviewStatus: Mapping["reviewStatus"] = question.optional ? "auto_accepted" : "needs_review";
    if (question.parentNumber) {
      // A single answer labelled with just the parent number (e.g. "11") scores
      // equally against every sub-part 11.a/11.b/11.c, but the one-to-one
      // assignment can only give it to one of them. The siblings that lost the race
      // are not truly blank — flag them for manual review instead of reporting a
      // plain "no answer assigned" that looks like nothing was written.
      for (const column of matchedColumns) {
        if (matrix[row][column] < config.reviewThreshold) continue;
        const winner = columnWinner.get(column);
        if (winner && winner.parentNumber === question.parentNumber) {
          notes = [
            `possible shared answer: question ${winner.displayNumber} was assigned an ` +
              "answer that also scored a plausible match here — the student may have " +
              "answered this whole multi-part question in one block; review manually",
          ];
          reviewStatus = "needs_review";
          break;
        }
      }
    }
    mappings.push({
      questionId: question.questionId,
      answerId: null,
      mappingType: "unanswered",
      confidence: 0.0,
      reviewStatus,
      regions: [],
      evidence: {
        stage: "unanswered",
        labelScore: 0,
        spatialScore: 0,
        semanticScore: 0,
        combinedScore: 0,
        runnerUpScore: null,
        runnerUpQuestionId: null,
        llmVerdict: null,
        notes,
      },
    });
  });

  answers.forEach((answer, column) => {
    if (matchedColumns.has(column)) return;
    mappings.push(unmatched(answer));
  });

  return { mappings, usedLlm };
}

/** Extra answers are kept and surfaced, never discarded. */
function unmatched(answer: ExtractedAnswer): Mapping {
  return {
    questionId: null,
    answerId: answer.answerId,
    mappingType: "unmatched",
    confidence: 0.0,
    reviewStatus: "needs_review",
    regions: [...answer.regions],
    evidence: {
      stage: "unmatched",
      labelScore: 0,
      spatialScore: 0,
      semanticScore: 0,
      combinedScore: 0,
      runnerUpScore: null,
      runnerUpQuestionId: null,
      llmVerdict: null,
      notes: ["answer assigned to no question"],
    },
  };
}

function dominantStage(label: number, spatial: number, semantic: number): string {
  if (label >= stages.LABEL_EXACT) return "label";
  const ranked: Record<string, number> = { label, spatial, semantic };
  return Object.entries(ranked).reduce((best, entry) => (entry[1] > ranked[best] ? entry[0] : best), "label");
}

function mappingType(evidence: MappingEvidence): Mapping["mappingType"] {
  if (evidence.labelScore >= stages.LABEL_EXACT) return "direct";
  if (evidence.semanticScore > evidence.spatialScore) return "semantic";
  return "spatial";
}
