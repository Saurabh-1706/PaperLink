import type { PageImage, Question, RawAnswerBlock } from "@/types";
import { v4 as uuid } from "uuid";
import {
  QUESTION_EXTRACTION_PROMPT,
  buildAnswerExtractionPrompt,
  buildGradingPrompt,
  extractJson,
} from "./shared";
import type { AiProvider } from "./provider";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_URL = "https://api.openai.com/v1/chat/completions";

async function callOpenAI(prompt: string, images: PageImage[], maxTokens = 4096): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  // OpenAI's vision input takes image data URLs directly, no need to split
  // out the base64/media-type the way Anthropic/Gemini require.
  const content: any[] = images.map((img) => ({
    type: "image_url",
    image_url: { url: img.dataUrl },
  }));
  content.push({ type: "text", text: prompt });

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{ role: "user", content }],
  });

  // Image-heavy prompts eat through OpenAI's tokens-per-minute cap fast even
  // when request *counts* are low, and a TPM bucket that's already fully
  // drained (e.g. by repeated testing) can need most of a rolling 60s window
  // to recover — not just the few seconds OpenAI's own message suggests for
  // the *next* small increment. Retry generously, but keep total wait under
  // ~45s so this stays inside the route's 60s function timeout.
  const MAX_ATTEMPTS = 6;
  const MAX_TOTAL_WAIT_MS = 45_000;
  let res: Response;
  let errText = "";
  let totalWaited = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
    });
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;

    errText = await res.text();
    let waitMs = 5_000; // fallback if the message doesn't parse
    const match = /try again in ([\d.]+)(ms|s)/i.exec(errText);
    if (match) {
      const value = parseFloat(match[1]);
      waitMs = Math.ceil(match[2].toLowerCase() === "ms" ? value : value * 1000) + 250; // small buffer
    }
    if (totalWaited + waitMs > MAX_TOTAL_WAIT_MS) break; // would blow the function timeout — surface the error instead

    console.warn(`[openai] rate-limited (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    totalWaited += waitMs;
  }

  if (!res!.ok) {
    if (!errText) errText = await res!.text();
    throw new Error(`OpenAI API error ${res!.status}: ${errText}`);
  }
  const data = await res!.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export const openaiProvider: AiProvider = {
  name: "openai",

  async extractQuestions(pages: PageImage[]): Promise<Question[]> {
    const text = await callOpenAI(QUESTION_EXTRACTION_PROMPT, pages);
    const raw = extractJson<{ number: string; text: string; marks: number | null }[]>(text);
    return raw.map((q, i) => ({ id: uuid(), number: q.number, text: q.text, marks: q.marks ?? null, order: i }));
  },

  async extractAnswers(pages: PageImage[], questions: Question[]): Promise<RawAnswerBlock[]> {
    const prompt = buildAnswerExtractionPrompt(questions);
    const text = await callOpenAI(prompt, pages, 8192);
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
    const text = await callOpenAI(prompt, [], 4096);
    return extractJson(text);
  },
};
