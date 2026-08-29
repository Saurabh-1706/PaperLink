import type { PageImage, Question, RawAnswerBlock } from "@/types";
import { v4 as uuid } from "uuid";
import {
  QUESTION_EXTRACTION_PROMPT,
  buildAnswerExtractionPrompt,
  buildGradingPrompt,
  extractJson,
  toImagePart,
} from "./shared";
import type { AiProvider } from "./provider";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const API_URL = "https://api.anthropic.com/v1/messages";

async function callClaude(prompt: string, images: PageImage[], maxTokens = 4096): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const content: any[] = images.map((img) => {
    const { mediaType, base64 } = toImagePart(img);
    return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
  });
  content.push({ type: "text", text: prompt });

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.content.map((c: any) => c.text ?? "").join("");
}

export const anthropicProvider: AiProvider = {
  name: "anthropic",

  async extractQuestions(pages: PageImage[]): Promise<Question[]> {
    const text = await callClaude(QUESTION_EXTRACTION_PROMPT, pages);
    const raw = extractJson<{ number: string; text: string; marks: number | null }[]>(text);
    return raw.map((q, i) => ({ id: uuid(), number: q.number, text: q.text, marks: q.marks ?? null, order: i }));
  },

  async extractAnswers(pages: PageImage[], questions: Question[]): Promise<RawAnswerBlock[]> {
    const prompt = buildAnswerExtractionPrompt(questions);
    const text = await callClaude(prompt, pages, 8192);
    const raw = extractJson<
      {
        questionNumberGuess: string | null;
        bestMatchNumber: string | null;
        confidence: number;
        text: string;
        regions: { page: number; x: number; y: number; width: number; height: number }[];
      }[]
    >(text);
    return raw.map((r) => ({
      id: uuid(),
      questionNumberGuess: r.bestMatchNumber ?? r.questionNumberGuess ?? null,
      confidence: r.confidence ?? 0.5,
      text: r.text,
      regions: r.regions,
    }));
  },

  async gradeAnswers(questions, answers) {
    const prompt = buildGradingPrompt(questions, answers);
    const text = await callClaude(prompt, [], 4096);
    return extractJson(text);
  },
};
