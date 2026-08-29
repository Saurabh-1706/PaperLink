import type { PageImage, Question, RawAnswerBlock } from "../types";

export interface AiProvider {
  name: string;
  extractQuestions(pages: PageImage[]): Promise<Question[]>;
  extractAnswers(pages: PageImage[], questions: Question[]): Promise<RawAnswerBlock[]>;
  gradeAnswers(
    questions: Question[],
    answers: { questionNumber: string; text: string }[]
  ): Promise<
    { questionNumber: string; isCorrect: boolean | null; score: number | null; maxScore: number | null; feedback: string }[]
  >;
}

function resolveProvider(which: string): AiProvider {
  if (which === "gemini") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./gemini").geminiProvider as AiProvider;
  }
  if (which === "anthropic") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./anthropic").anthropicProvider as AiProvider;
  }
  if (which === "openai") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./openai").openaiProvider as AiProvider;
  }
  if (which === "mistral") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./mistral").mistralProvider as AiProvider;
  }
  throw new Error(
    'No AI provider configured. Set AI_PROVIDER (or ANSWER_PROVIDER) to "gemini" (with GEMINI_API_KEY), ' +
      '"anthropic" (with ANTHROPIC_API_KEY), "openai" (with OPENAI_API_KEY), or "mistral" (with MISTRAL_API_KEY) ' +
      "in your .env.local."
  );
}

/** Main provider — used for question extraction and grading. */
export function getProvider(): AiProvider {
  return resolveProvider((process.env.AI_PROVIDER || "").toLowerCase());
}

/**
 * Provider used specifically for answer extraction. Defaults to the main
 * provider, but can be overridden independently via ANSWER_PROVIDER — useful
 * when one provider's free tier is a better fit for the harder
 * (bounding-box + handwriting OCR + matching) answer-extraction task than for
 * the rest of the pipeline. Requires that provider's own API key to also be
 * set (e.g. ANSWER_PROVIDER=openai needs OPENAI_API_KEY).
 */
export function getAnswerProvider(): AiProvider {
  const override = (process.env.ANSWER_PROVIDER || "").toLowerCase();
  if (override) return resolveProvider(override);
  return getProvider();
}
