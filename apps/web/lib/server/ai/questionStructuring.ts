/**
 * Question-structure disambiguation. Port of backend/app/ai/prompts/questions.py +
 * the `provider.structure_blocks` call site in graphs/question_graph.py, collapsed
 * into one adapter following ocr.ts's shape (prompt + schema + one callWithCascade
 * call + safeParse + null on any failure — never throw).
 *
 * The model receives block ids and returns block ids. It never returns coordinates
 * (ADR-001) — the caller (graphs/question_graph.ts) resolves ids back to stored
 * bboxes and silently drops any id the model invents that isn't a real block.
 */
import { z } from "zod";
import { callWithCascade, textPart } from "./gemini";
import { settings } from "@/lib/server/config";

const PROMPT_VERSION = "question-structure.v1";

const ProposalSchema = z.object({
  display_number: z.string(),
  block_ids: z.array(z.string()),
});
const ResponseSchema = z.object({ questions: z.array(ProposalSchema) });

export interface QuestionStructureProposal {
  displayNumber: string;
  blockIds: string[];
}

function buildPrompt(blocks: Array<[string, string]>, issues: string[]): string {
  const lines = [
    `[${PROMPT_VERSION}]`,
    "The deterministic parser flagged these problems with an exam paper's numbering:",
    ...issues.map((issue) => `- ${issue}`),
    "",
    "Blocks, in reading order (id: text):",
  ];
  for (const [blockId, text] of blocks) {
    lines.push(`${blockId}: ${text.slice(0, 300)}`);
  }
  lines.push("");
  lines.push(
    'Return JSON: {"questions": [{"display_number": "11(a)", "block_ids": ["..."]}]}. ' +
      "Use only ids listed above. Never return coordinates."
  );
  return lines.join("\n");
}

/** Returns null if every model in the cascade failed, the response didn't parse, or
 * it proposed no questions — callers must fall back to the deterministic result. */
export async function structureQuestionBlocks(
  blocks: Array<[string, string]>,
  issues: string[]
): Promise<QuestionStructureProposal[] | null> {
  const prompt = buildPrompt(blocks, issues);
  const raw = await callWithCascade(settings.geminiModelCascade, [textPart(prompt)]);
  if (raw === null) return null;

  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.questions.length === 0) return null;
  return parsed.data.questions.map((q) => ({ displayNumber: q.display_number, blockIds: q.block_ids }));
}
