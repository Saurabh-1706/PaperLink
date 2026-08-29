import type { PageImage, Question, RawAnswerBlock } from "../types";
import { v4 as uuid } from "uuid";
import {
  QUESTION_EXTRACTION_PROMPT,
  buildAnswerExtractionPrompt,
  buildGradingPrompt,
  extractJson,
} from "./shared";
import type { AiProvider } from "./provider";

// Mistral's free "Experiment" tier includes Pixtral (their vision model) at
// no cost — unlike Anthropic (trial credits only, no ongoing free tier) and
// Gemini/OpenAI, whose free/trial budgets this app kept exhausting. The
// tradeoff: it's capped at a very low RPM (reportedly ~2/min), so this is
// best used for the answer-extraction step specifically via ANSWER_PROVIDER,
// relying on the retry-on-429 below plus the route's sequential batching
// (app/api/extract-answers/route.ts) rather than raw throughput.
const MODEL = process.env.MISTRAL_MODEL || "pixtral-12b-2409";
const API_URL = "https://api.mistral.ai/v1/chat/completions";

async function callMistral(prompt: string, images: PageImage[], maxTokens = 4096): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY is not set");

  // Mistral's image_url content part is a bare data-URL string, NOT an
  // {url: ...} object the way OpenAI's is — easy to get wrong since the two
  // APIs otherwise look identical.
  const content: any[] = images.map((img) => ({
    type: "image_url",
    image_url: img.dataUrl,
  }));
  content.push({ type: "text", text: prompt });

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{ role: "user", content }],
  });

  // At ~2 RPM on the free tier, a 429 here is expected on any multi-batch
  // answer sheet, not just an edge case. Honor the standard HTTP
  // "Retry-After" header if Mistral sends one; otherwise assume the full
  // ~30s spacing a 2 RPM budget implies.
  const MAX_ATTEMPTS = 4;
  const MAX_TOTAL_WAIT_MS = 90_000;
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

    const retryAfterHeader = res.headers.get("retry-after");
    let waitMs = retryAfterHeader ? Math.ceil(parseFloat(retryAfterHeader) * 1000) : 31_000;
    if (!Number.isFinite(waitMs) || waitMs <= 0) waitMs = 31_000;
    if (totalWaited + waitMs > MAX_TOTAL_WAIT_MS) break;

    console.warn(`[mistral] rate-limited (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    totalWaited += waitMs;
  }

  if (!res!.ok) {
    errText = await res!.text();
    throw new Error(`Mistral API error ${res!.status}: ${errText}`);
  }
  const data = await res!.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export const mistralProvider: AiProvider = {
  name: "mistral",

  async extractQuestions(pages: PageImage[]): Promise<Question[]> {
    const text = await callMistral(QUESTION_EXTRACTION_PROMPT, pages);
    const raw = extractJson<{ number: string; text: string; marks: number | null }[]>(text);
    return raw.map((q, i) => ({ id: uuid(), number: q.number, text: q.text, marks: q.marks ?? null, order: i }));
  },

  async extractAnswers(pages: PageImage[], questions: Question[]): Promise<RawAnswerBlock[]> {
    // Pixtral has no native bounding-box grounding (unlike Gemini) — uses the
    // same grid-overlay + fractional-coordinate prompt as OpenAI/Anthropic.
    const prompt = buildAnswerExtractionPrompt(questions);
    const text = await callMistral(prompt, pages, 8192);
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
    const text = await callMistral(prompt, [], 4096);
    return extractJson(text);
  },
};
