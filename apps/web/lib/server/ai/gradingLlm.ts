/**
 * Rubric-scoring of open-ended answers. Port of backend/app/ai/prompts/grading.py,
 * collapsed into one adapter following ocr.ts's shape.
 */
import { z } from "zod";
import { callWithCascade, textPart } from "./gemini";
import { settings } from "@/lib/server/config";

const PROMPT_VERSION = "rubric-scoring.v1";

const BreakdownItemSchema = z.object({
  name: z.string().default("criterion"),
  awarded: z.number().default(0),
  max_marks: z.number().default(0),
  rationale: z.string().default(""),
});

const ResponseSchema = z.object({
  score: z.number(),
  feedback: z.string().optional(),
  breakdown: z.array(BreakdownItemSchema).optional(),
});

export interface GradingLlmResult {
  score: number;
  feedback: string;
  breakdown: Array<{ name: string; awarded: number; maxMarks: number; rationale: string }>;
}

function buildPrompt(
  questionText: string,
  answerText: string,
  maxMarks: number,
  criteria: Array<[string, number]>
): string {
  const lines = [
    `[${PROMPT_VERSION}]`,
    "Score a student's exam answer against the rubric. Be strict and concise.",
    "",
    `QUESTION: ${questionText}`,
    `MAX MARKS: ${maxMarks}`,
    "RUBRIC:",
  ];
  for (const [name, weight] of criteria) lines.push(`- ${name} (weight ${weight})`);
  lines.push("", `STUDENT ANSWER: ${answerText}`, "");
  lines.push(
    'Return JSON: {"score": <0..MAX>, "feedback": "<two sentences>", ' +
      '"breakdown": [{"name": "...", "awarded": 0, "max_marks": 0, "rationale": "..."}]}'
  );
  return lines.join("\n");
}

/** Returns null if every model in the cascade failed or the response didn't parse —
 * the caller must fall back to a deterministic grade (never require an LLM). */
export async function gradeWithLlm(
  questionText: string,
  answerText: string,
  maxMarks: number,
  criteria: Array<[string, number]>
): Promise<GradingLlmResult | null> {
  const prompt = buildPrompt(questionText, answerText, maxMarks, criteria);
  const raw = await callWithCascade(settings.geminiModelCascade, [textPart(prompt)]);
  if (raw === null) return null;

  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    score: parsed.data.score,
    feedback: (parsed.data.feedback ?? "").slice(0, 1000),
    breakdown: (parsed.data.breakdown ?? []).map((item) => ({
      name: item.name,
      awarded: item.awarded,
      maxMarks: item.max_marks,
      rationale: item.rationale,
    })),
  };
}
