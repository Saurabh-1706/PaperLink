/**
 * Mapping stage 5 — bounded, cheap, auditable validation. Port of
 * backend/app/ai/prompts/mapping.py, collapsed into one adapter following
 * ocr.ts's shape. Not "map these for me": the caller (mapping_engine/engine.ts)
 * only reaches this for rows in the ambiguous band, with at most 3 candidates.
 */
import { z } from "zod";
import { callWithCascade, textPart } from "./gemini";
import { settings } from "@/lib/server/config";

const PROMPT_VERSION = "mapping-validation.v1";

const ResponseSchema = z.object({
  answer_id: z.string().nullable(),
  reason: z.string().optional(),
});

export interface MappingVerdict {
  answerId: string | null;
  reason: string;
}

function buildPrompt(questionText: string, candidates: Array<{ answerId: string; text: string }>): string {
  const lines = [
    `[${PROMPT_VERSION}]`,
    "You are checking which candidate answer belongs to one exam question.",
    "Choose exactly one candidate, or null if none fits.",
    "",
    `QUESTION: ${questionText}`,
    "",
    "CANDIDATES:",
  ];
  for (const { answerId, text } of candidates) lines.push(`- id=${answerId}: ${text}`);
  lines.push("");
  lines.push('Return JSON: {"answer_id": "<id or null>", "reason": "<one short sentence>"}');
  return lines.join("\n");
}

/** Returns null if every model in the cascade failed or the response didn't parse —
 * the caller must leave the matrix cell unboosted in that case (never require an LLM). */
export async function validateMapping(
  questionText: string,
  candidates: Array<{ answerId: string; text: string }>
): Promise<MappingVerdict | null> {
  const prompt = buildPrompt(questionText, candidates);
  const raw = await callWithCascade(settings.geminiModelCascade, [textPart(prompt)]);
  if (raw === null) return null;

  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { answerId: parsed.data.answer_id, reason: parsed.data.reason ?? "" };
}
