/**
 * answer_graph — segmentation, then vision validation for low-confidence regions
 * only. Port of backend/app/graphs/answer_graph.py as a plain function (see the
 * module comment in mapping_graph.ts).
 */
import type { IRDocument } from "../modules/extraction/types";
import { extractAnswers } from "../modules/answer_pipeline/pipeline";
import type { AnswerPipelineResult } from "../modules/answer_pipeline/types";
import { validateTranscriptions } from "../modules/answer_pipeline/vision";

export async function runAnswerGraph(
  ir: IRDocument,
  pageImages: Map<number, Buffer>
): Promise<AnswerPipelineResult> {
  const segmented = extractAnswers(ir);
  let answers = segmented.answers;
  let usedLlm = false;

  if (segmented.lowConfidenceAnswerIds.length > 0 && pageImages.size > 0) {
    const [validated, used] = await validateTranscriptions(
      answers,
      pageImages,
      segmented.lowConfidenceAnswerIds
    );
    answers = validated;
    usedLlm = used;
  }

  const lowConfidenceSet = new Set(segmented.lowConfidenceAnswerIds);
  const remaining = answers
    .filter((a) => lowConfidenceSet.has(a.answerId) && a.confidence < 0.9)
    .map((a) => a.answerId);

  return { answers, lowConfidenceAnswerIds: remaining, usedLlm };
}
