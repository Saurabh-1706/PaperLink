/**
 * mapping_graph — deterministic solve first; the LLM band is entered only if the
 * deterministic pass left mappings under the accept threshold. Port of
 * backend/app/graphs/mapping_graph.py as a plain function (see ADR-002 / the
 * project decision recorded for this migration: these graphs are 2-3 nodes with
 * one conditional branch and no cycles/retries, so a hand-rolled if/branch
 * reproduces the exact control flow without a graph-library dependency).
 *
 * Deliberately keeps the Python version's double-computation: when the LLM band is
 * entered, `mapAnswers` runs twice — once deterministic-only to detect whether any
 * mapping needs it, then again fully with the validator enabled. That is a known
 * inefficiency in the original, not something to silently optimize away.
 */
import type { ExtractedAnswer } from "../modules/answer_pipeline/types";
import type { ExtractedQuestion } from "../modules/question_pipeline/types";
import { defaultMappingConfig, mapAnswers, type MappingConfig, type MappingValidator } from "../modules/mapping_engine/engine";
import type { MappingResult } from "../modules/mapping_engine/types";

export async function runMappingGraph(
  questions: ExtractedQuestion[],
  answers: ExtractedAnswer[],
  validate?: MappingValidator,
  config: MappingConfig = defaultMappingConfig()
): Promise<MappingResult> {
  const deterministic = await mapAnswers(questions, answers, { ...config, useLlm: false });
  const needsLlm = deterministic.mappings.some(
    (m) => m.reviewStatus === "needs_review" && m.mappingType !== "unanswered"
  );

  if (!needsLlm || !validate || !config.useLlm) {
    return { ...deterministic, usedLlm: false };
  }

  const validated = await mapAnswers(questions, answers, config, validate);
  return { ...validated, usedLlm: validated.usedLlm };
}
