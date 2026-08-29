import { endpoints } from "@/lib/api/endpoints";
import { http } from "@/lib/api/httpClient";
import type { GradingSummary, MappedAnswer, PageImage, Question, RawAnswerBlock } from "@/types";

/**
 * The pipeline, as the UI sees it. Components never touch `fetch`, URLs or
 * response envelopes — swapping these four calls onto the FastAPI service is a
 * change to this file and lib/api/endpoints.ts alone.
 */

export interface PipelineConfig {
  provider: string;
  answerProvider: string;
}

export const assessmentApi = {
  getConfig: (signal?: AbortSignal) => http.get<PipelineConfig>(endpoints.pipeline.config, { signal }),

  extractQuestions: (pages: PageImage[], signal?: AbortSignal) =>
    http
      .post<{ questions: Question[] }>(endpoints.pipeline.extractQuestions, { pages }, { signal })
      .then((r) => r.questions),

  extractAnswers: (pages: PageImage[], questions: Question[], signal?: AbortSignal) =>
    http
      .post<{ rawAnswers: RawAnswerBlock[] }>(
        endpoints.pipeline.extractAnswers,
        { pages, questions },
        { signal }
      )
      .then((r) => r.rawAnswers),

  grade: (questions: Question[], rawAnswers: RawAnswerBlock[], signal?: AbortSignal) =>
    http.post<{ mappings: MappedAnswer[]; summary: GradingSummary }>(
      endpoints.pipeline.grade,
      { questions, rawAnswers },
      { signal }
    ),
};
