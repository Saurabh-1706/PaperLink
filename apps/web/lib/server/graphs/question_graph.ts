/**
 * question_graph — deterministic extraction, then ambiguity routing. Port of
 * backend/app/graphs/question_graph.py as a plain function (see the module
 * comment in mapping_graph.ts for why this isn't a graph-library dependency).
 *
 * The LLM step runs only when the deterministic checks flagged an ambiguity, and it
 * receives block ids and returns block ids (ADR-001).
 */
import type { BBox } from "../modules/extraction/geometry";
import type { IRBlock, IRDocument } from "../modules/extraction/types";
import { orderedBlocks } from "../modules/extraction/types";
import { unionAll } from "../modules/common";
import { normalizeLabel, parentOf } from "../modules/question_pipeline/labels";
import { extractQuestions } from "../modules/question_pipeline/pipeline";
import type { ExtractedQuestion, QuestionPipelineResult } from "../modules/question_pipeline/types";
import { structureQuestionBlocks, type QuestionStructureProposal } from "../ai/questionStructuring";

const MAX_BLOCKS_IN_PROMPT = 120;

export async function runQuestionGraph(ir: IRDocument): Promise<QuestionPipelineResult> {
  const result = extractQuestions(ir);
  if (result.ambiguities.length === 0) return result;

  const ordered = orderedBlocks(ir).slice(0, MAX_BLOCKS_IN_PROMPT);
  const proposals = await structureQuestionBlocks(
    ordered.map(({ block }): [string, string] => [block.blockId, block.text]),
    result.ambiguities
  );
  // Deterministic result stands: no pipeline may require an LLM to produce output.
  if (proposals === null) return { ...result, usedLlm: true };

  const repaired = applyStructure(ir, proposals, result);
  if (repaired === null) return { ...result, usedLlm: true };
  return repaired;
}

function applyStructure(
  ir: IRDocument,
  proposals: QuestionStructureProposal[],
  previous: QuestionPipelineResult
): QuestionPipelineResult | null {
  const index = new Map<string, { page: number; block: IRBlock }>();
  for (const entry of orderedBlocks(ir)) index.set(entry.block.blockId, entry);

  const questions: ExtractedQuestion[] = [];
  proposals.forEach((proposal, order) => {
    const blockIds = proposal.blockIds.filter((id) => index.has(id));
    if (blockIds.length === 0) return;

    const byPage = new Map<number, BBox[]>();
    const texts: string[] = [];
    for (const id of blockIds) {
      const entry = index.get(id)!;
      const boxes = byPage.get(entry.page) ?? [];
      boxes.push(entry.block.bbox);
      byPage.set(entry.page, boxes);
      texts.push(entry.block.text);
    }

    const display = proposal.displayNumber.trim();
    if (!display) return;
    const normalized = normalizeLabel(display, false) ?? display;
    questions.push({
      questionId: `q-${normalized}`,
      displayNumber: display,
      normalizedNumber: normalized,
      parentNumber: parentOf(normalized),
      text: texts.join(" ").trim(),
      pages: [...byPage.keys()].sort((a, b) => a - b),
      regions: [...byPage.entries()].sort(([a], [b]) => a - b).map(([page, boxes]) => ({ page, bbox: unionAll(boxes) })),
      orderIndex: order,
      optional: false,
      maxMarks: null,
      confidence: 0.75, // model-repaired structure is never treated as certain
      blockIds,
    });
  });

  if (questions.length === 0) return null;
  return { ...previous, questions, usedLlm: true };
}
