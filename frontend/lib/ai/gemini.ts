import type { PageImage, Question, RawAnswerBlock } from "@/types";
import { v4 as uuid } from "uuid";
import { QUESTION_EXTRACTION_PROMPT, buildGradingPrompt, extractJson, toImagePart } from "./shared";
import type { AiProvider } from "./provider";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Answer extraction is a much harder compound task than question extraction —
// spatial bounding-box detection + handwriting OCR + question matching, all
// in one structured response — and Lite-tier models can fail it silently
// (return an empty array rather than an error) where they handle plain OCR
// fine. Let it use a stronger model by default; falls back to MODEL if unset
// so a single GEMINI_MODEL still works for anyone who hasn't hit this.
const ANSWER_MODEL = process.env.GEMINI_ANSWER_MODEL || MODEL;

/**
 * Gemini (unlike GPT-4o/Claude) has an actual trained object-detection head:
 * asked for "box_2d" in this exact [ymin, xmin, ymax, xmax] / 0-1000 format,
 * it returns real spatial grounding instead of a freehand guess. This is
 * Google's documented convention for the feature — don't ask for x/y/width/
 * height fractions here, that throws away the accuracy this format buys.
 * https://ai.google.dev/gemini-api/docs/vision#bounding-boxes
 */
function buildGeminiAnswerExtractionPrompt(questions: Question[]): string {
  const questionList = questions.map((q) => `${q.number}: ${q.text.slice(0, 160)}`).join("\n");
  return `You are analyzing scanned pages of a STUDENT's handwritten answer sheet, written in
response to the following question paper (numbers and a short excerpt of each question). The
pages are provided as separate images, in order, 0-indexed as "page".

${questionList}

Find every distinct block of handwritten answer content on the sheet, in whatever order the
student wrote it (students often answer out of order). For each block, detect its bounding box
and report it as "box_2d": [ymin, xmin, ymax, xmax], each an integer from 0 to 1000, normalized
to that image's dimensions — this is a precise detection, not an estimate, so make it tight
around the actual handwriting.

For each block also report:
- "page": the 0-based index of the image this block appears on.
- "questionNumberGuess": any question number/label the student wrote next to or above it (e.g. "Q2", "3(b)"). Null if no legible label exists.
- "bestMatchNumber": the printed question number (from the list above) this content most plausibly answers, based on subject matter, even with no label. Null if it doesn't match anything in the list (rough work, doodles, an answer to a question not listed).
- "confidence": 0 to 1, confidence that bestMatchNumber is correct.
- "text": your best transcription of the handwriting (mark illegible spans as [illegible]).

An answer spanning multiple pages should be reported as multiple separate block entries (one
per page it appears on) sharing the same bestMatchNumber.

Respond with ONLY a JSON array, no commentary, in this exact shape:
[
  {
    "box_2d": [420, 80, 610, 920],
    "page": 0,
    "questionNumberGuess": "3(b)",
    "bestMatchNumber": "3(b)",
    "confidence": 0.9,
    "text": "transcribed answer text..."
  }
]`;
}

async function callGemini(
  prompt: string,
  images: PageImage[],
  maxOutputTokens = 8192,
  model: string = MODEL
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const parts: any[] = images.map((img) => {
    const { mediaType, base64 } = toImagePart(img);
    return { inlineData: { mimeType: mediaType, data: base64 } };
  });
  parts.push({ text: prompt });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens },
  });

  // Free-tier RPM caps are tight enough (as low as 5/min on some models) that
  // a single burst of requests can trip one. Google's 429 body tells us
  // exactly how long to wait (RetryInfo.retryDelay) — honor it instead of
  // failing the whole pipeline outright.
  const MAX_ATTEMPTS = 3;
  let res: Response;
  let errText = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;

    errText = await res.text();
    let waitMs = 15_000; // fallback if the response doesn't include a suggested delay
    try {
      const parsed = JSON.parse(errText);
      const retryInfo = parsed.error?.details?.find((d: any) => d["@type"]?.includes("RetryInfo"));
      const match = /^(\d+(?:\.\d+)?)s$/.exec(retryInfo?.retryDelay ?? "");
      if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 500; // small buffer past the exact reset
    } catch {
      // Couldn't parse the suggested delay — fall back to the default above.
    }
    console.warn(`[gemini] ${model} rate-limited (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!res!.ok) {
    if (!errText) errText = await res!.text();
    throw new Error(`Gemini API error ${res!.status}: ${errText}`);
  }
  const data = await res!.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error(`Gemini returned no candidates: ${JSON.stringify(data).slice(0, 300)}`);
  const text = candidate.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    // A thinking-enabled model can spend its whole budget reasoning and emit
    // nothing, or a lite/distilled model can bail on a task it can't do
    // confidently (e.g. box_2d spatial grounding) by returning no content —
    // either way this is silent unless logged, since it's valid-but-empty
    // rather than an HTTP error.
    console.warn(
      `[gemini] ${model} returned empty text (finishReason: ${candidate.finishReason ?? "unknown"}). ` +
        `Raw candidate: ${JSON.stringify(candidate).slice(0, 500)}`
    );
  }
  return text;
}

export const geminiProvider: AiProvider = {
  name: "gemini",

  async extractQuestions(pages: PageImage[]): Promise<Question[]> {
    const text = await callGemini(QUESTION_EXTRACTION_PROMPT, pages);
    const raw = extractJson<{ number: string; text: string; marks: number | null }[]>(text);
    return raw.map((q, i) => ({ id: uuid(), number: q.number, text: q.text, marks: q.marks ?? null, order: i }));
  },

  async extractAnswers(pages: PageImage[], questions: Question[]): Promise<RawAnswerBlock[]> {
    // Use Gemini's native box_2d grounding, not the generic grid-overlay prompt the
    // other providers need — Gemini has a real detection head for this, so a
    // freehand-fraction prompt would only throw accuracy away. See the note above
    // buildGeminiAnswerExtractionPrompt.
    const prompt = buildGeminiAnswerExtractionPrompt(questions);
    // 65536 is Gemini 2.5 Flash's maximum output-token limit; answer sheets with
    // many questions need every token — the 8 192 default gets truncated mid-JSON.
    // Uses ANSWER_MODEL (see its definition above) rather than MODEL: this is the
    // hardest step in the pipeline and a Lite-tier model can silently fail it.
    const text = await callGemini(prompt, pages, 65536, ANSWER_MODEL);
    const raw = extractJson<
      {
        box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax], 0-1000
        page: number;
        questionNumberGuess: string | null;
        bestMatchNumber: string | null;
        confidence: number;
        text: string;
      }[]
    >(text);
    return raw.map((r) => {
      const [ymin, xmin, ymax, xmax] = r.box_2d;
      return {
        id: uuid(),
        questionNumberGuess: r.bestMatchNumber ?? r.questionNumberGuess ?? null,
        confidence: r.confidence ?? 0.5,
        text: r.text,
        regions: [
          {
            page: r.page ?? 0,
            x: xmin / 1000,
            y: ymin / 1000,
            width: (xmax - xmin) / 1000,
            height: (ymax - ymin) / 1000,
          },
        ],
      };
    });
  },

  async gradeAnswers(questions, answers) {
    const prompt = buildGradingPrompt(questions, answers);
    const text = await callGemini(prompt, []);
    return extractJson(text);
  },
};
