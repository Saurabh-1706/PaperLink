"use client";

import { useCallback, useMemo, useState } from "react";
import { assessmentApi } from "../api/assessmentApi";
import { errorMessage } from "@/lib/api/errors";
import { addCoordinateGrid } from "@/lib/gridOverlay";
import { fileToPageImages } from "@/lib/pdf";
import type { GradingSummary, MappedAnswer, PageImage, ProcessingStage, Question } from "@/types";

/**
 * The whole extraction → mapping → grading run, as one hook. This is the only
 * place that sequences the pipeline; the stage components are presentational
 * and receive what they render.
 */
export function useAssessmentPipeline() {
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [questionPages, setQuestionPages] = useState<PageImage[]>([]);
  const [answerPages, setAnswerPages] = useState<PageImage[]>([]);

  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [mappings, setMappings] = useState<MappedAnswer[]>([]);
  const [unmatched, setUnmatched] = useState<MappedAnswer[]>([]);
  const [gradingSummary, setGradingSummary] = useState<GradingSummary | null>(null);

  /**
   * The total is derived, never stored: a score override changes `mappings`, and
   * the summary follows. (It used to be written from inside a state updater,
   * which double-applied under StrictMode.)
   */
  const summary = useMemo<GradingSummary | null>(() => {
    if (!gradingSummary) return null;
    const graded = mappings.filter((m) => typeof m.score === "number");
    if (!graded.length) return gradingSummary;
    return { ...gradingSummary, totalScore: graded.reduce((sum, m) => sum + (m.score ?? 0), 0) };
  }, [gradingSummary, mappings]);

  const process = useCallback(async () => {
    if (!questionFile || !answerFile) return;
    setError(null);
    setStage("rendering-pages");
    try {
      const [qPages, aPages] = await Promise.all([
        fileToPageImages(questionFile),
        fileToPageImages(answerFile),
      ]);
      setQuestionPages(qPages);
      setAnswerPages(aPages);

      setStage("extracting-questions");
      const extractedQuestions = await assessmentApi.extractQuestions(qPages);
      setQuestions(extractedQuestions);

      setStage("extracting-answers");
      // Gemini has native bounding-box grounding and doesn't need (or want —
      // it's just visual clutter) the grid crutch other providers need. Ask
      // which provider actually handles answer extraction (it can differ from
      // the main provider — see ANSWER_PROVIDER) before deciding whether to
      // overlay it.
      const { answerProvider } = await assessmentApi.getConfig();
      const answerPagesForApi =
        answerProvider === "gemini" ? aPages : await Promise.all(aPages.map((p) => addCoordinateGrid(p)));
      const rawAnswers = await assessmentApi.extractAnswers(answerPagesForApi, extractedQuestions);

      setStage("mapping-grading");
      const graded = await assessmentApi.grade(extractedQuestions, rawAnswers);

      const all: MappedAnswer[] = Array.isArray(graded.mappings) ? graded.mappings : [];
      setMappings(all.filter((m) => m.status !== "unmatched"));
      setUnmatched(all.filter((m) => m.status === "unmatched"));
      setGradingSummary(graded.summary);
      setStage("done");
    } catch (err) {
      setError(errorMessage(err));
      setStage("error");
    }
  }, [questionFile, answerFile]);

  const reset = useCallback(() => {
    setQuestionFile(null);
    setAnswerFile(null);
    setQuestionPages([]);
    setAnswerPages([]);
    setQuestions([]);
    setMappings([]);
    setUnmatched([]);
    setGradingSummary(null);
    setStage("idle");
    setError(null);
  }, []);

  const overrideScore = useCallback((questionId: string, newScore: number) => {
    setMappings((prev) =>
      prev.map((m) => {
        if (m.questionId !== questionId) return m;
        const maxScore = m.maxScore ?? 5;
        return {
          ...m,
          score: newScore,
          isCorrect: newScore === maxScore ? true : newScore === 0 ? false : null,
        };
      })
    );
  }, []);

  // Teacher corrections to the AI's transcription/feedback — local-only, the
  // AI's original output isn't re-sent anywhere, this just overrides what's shown.
  const editAnswerText = useCallback((questionId: string, newText: string) => {
    setMappings((prev) => prev.map((m) => (m.questionId === questionId ? { ...m, answerText: newText } : m)));
  }, []);

  const editFeedback = useCallback((questionId: string, newFeedback: string) => {
    setMappings((prev) => prev.map((m) => (m.questionId === questionId ? { ...m, feedback: newFeedback } : m)));
  }, []);

  return {
    questionFile,
    answerFile,
    questionPages,
    answerPages,
    stage,
    error,
    questions,
    mappings,
    unmatched,
    summary,
    isProcessing: stage !== "idle" && stage !== "done" && stage !== "error",
    isComplete: stage === "done",
    setQuestionFile,
    setAnswerFile,
    clearQuestionFile: useCallback(() => setQuestionFile(null), []),
    clearAnswerFile: useCallback(() => setAnswerFile(null), []),
    process,
    reset,
    overrideScore,
    editAnswerText,
    editFeedback,
  };
}

export type AssessmentPipeline = ReturnType<typeof useAssessmentPipeline>;
