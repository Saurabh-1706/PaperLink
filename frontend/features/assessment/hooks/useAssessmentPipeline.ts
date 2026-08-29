"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assessmentApi } from "../api/assessmentApi";
import { errorMessage } from "@/lib/api/errors";
import {
  toGradingSummary,
  toMappedAnswer,
  toPageImages,
  toProcessingStage,
  toQuestion,
} from "@/lib/api/adapters";
import type { GradingSummary, MappedAnswer, PageImage, ProcessingStage, Question } from "@/types";
import type { JobDto } from "@/types/backend";

/**
 * The whole run — create → upload → process → poll → read — as one hook. This
 * is the only place that sequences it; the stage components are presentational.
 *
 * Nothing here does extraction, mapping or grading: that all happens on the
 * FastAPI service, which persists questions, answers, mappings and grades to
 * MongoDB and the page images and source PDFs to GridFS. What this hook holds
 * is a read-through cache of a run that outlives the browser tab, addressed by
 * `assessmentId`.
 */

const POLL_INTERVAL_MS = 1_200;
/** OCR of a long scan is slow; give up long after that rather than during it. */
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "physics-paper-2026.pdf" → "physics paper 2026" */
function titleFromFile(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base.slice(0, 300) || "Untitled assessment";
}

export function useAssessmentPipeline() {
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [questionPages, setQuestionPages] = useState<PageImage[]>([]);
  const [answerPages, setAnswerPages] = useState<PageImage[]>([]);

  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [error, setError] = useState<string | null>(null);
  /** A correction that failed to save. Kept apart from `error`, which ends the run. */
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [mappings, setMappings] = useState<MappedAnswer[]>([]);
  const [unmatched, setUnmatched] = useState<MappedAnswer[]>([]);
  const [gradingSummary, setGradingSummary] = useState<GradingSummary | null>(null);

  // One controller per run: reset() or unmount abandons the in-flight requests
  // and stops the poll loop rather than leaving them to resolve into a dead tree.
  const runRef = useRef<AbortController | null>(null);
  useEffect(() => () => runRef.current?.abort(), []);

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

  /** Polls until the job leaves the queue, reporting each stage as it lands. */
  const pollJob = useCallback(
    async (id: string, initial: JobDto, signal: AbortSignal): Promise<JobDto> => {
      let job = initial;
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      while (job.status === "queued" || job.status === "running") {
        if (Date.now() > deadline) {
          throw new Error("Processing is taking longer than expected. Check back shortly.");
        }
        setStage(toProcessingStage(job.stage));
        await sleep(POLL_INTERVAL_MS);
        if (signal.aborted) return job;
        job = await assessmentApi.job(id, job.job_id, signal);
      }
      return job;
    },
    []
  );

  /** Reads back everything the run produced and joins it into the review shapes. */
  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    const [questionDtos, answerDtos, mappingDtos, gradeDtos, results] = await Promise.all([
      assessmentApi.questions(id, signal),
      assessmentApi.answers(id, signal),
      assessmentApi.mappings(id, signal),
      assessmentApi.grades(id, signal),
      assessmentApi.results(id, signal),
    ]);

    const context = {
      questionsById: new Map(questionDtos.map((q) => [q.id, q])),
      answersById: new Map(answerDtos.map((a) => [a.id, a])),
      gradesByMapping: new Map(gradeDtos.map((g) => [g.mapping_id, g])),
    };
    const all = mappingDtos.map((dto) => toMappedAnswer(dto, context));

    setQuestions(questionDtos.map(toQuestion).sort((a, b) => a.order - b.order));
    setMappings(all.filter((m) => m.status !== "unmatched"));
    setUnmatched(all.filter((m) => m.status === "unmatched"));
    setGradingSummary(toGradingSummary(results, questionDtos.length));
  }, []);

  const process = useCallback(async () => {
    if (!questionFile || !answerFile) return;

    runRef.current?.abort();
    const controller = new AbortController();
    runRef.current = controller;
    const { signal } = controller;

    setError(null);
    setReviewError(null);
    setStage("rendering-pages");

    try {
      const assessment = await assessmentApi.create(titleFromFile(questionFile), signal);
      setAssessmentId(assessment.id);

      // Sequential, not parallel: each upload renders and OCRs its document
      // inline, and two of those at once only lengthens the slower one.
      const questionDoc = await assessmentApi.uploadQuestionPaper(
        assessment.id,
        questionFile,
        signal
      );
      setQuestionPages(toPageImages(questionDoc.document_id, questionDoc.page_count));

      const answerDoc = await assessmentApi.uploadAnswerSheet(assessment.id, answerFile, signal);
      setAnswerPages(toPageImages(answerDoc.document_id, answerDoc.page_count));

      const job = await pollJob(assessment.id, await assessmentApi.process(assessment.id, signal), signal);
      if (signal.aborted) return;
      if (job.status === "failed") {
        // The backend records a typed failure on the job rather than losing it
        // to a rollback, so there is always something specific to show.
        throw new Error(job.error ?? "Processing failed.");
      }

      setStage("mapping-grading");
      await load(assessment.id, signal);
      if (signal.aborted) return;
      setStage("done");
    } catch (err) {
      if (signal.aborted) return;
      setError(errorMessage(err));
      setStage("error");
    }
  }, [questionFile, answerFile, pollJob, load]);

  const reset = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
    setQuestionFile(null);
    setAnswerFile(null);
    setQuestionPages([]);
    setAnswerPages([]);
    setAssessmentId(null);
    setQuestions([]);
    setMappings([]);
    setUnmatched([]);
    setGradingSummary(null);
    setStage("idle");
    setError(null);
    setReviewError(null);
  }, []);

  /**
   * A teacher's mark. The score itself is shown from local state — the API has
   * no grade-override route yet — but the mapping is marked `human_corrected`
   * so the persisted record shows a human settled it and it is no longer
   * counted as needing review.
   */
  const overrideScore = useCallback(
    (questionId: string, newScore: number) => {
      const target = mappings.find((m) => m.questionId === questionId);

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

      if (!target) return;
      setReviewError(null);
      assessmentApi
        .patchMapping(target.mappingId, { review_status: "human_corrected" })
        .then((dto) =>
          setMappings((prev) =>
            prev.map((m) =>
              m.mappingId === dto.id ? { ...m, reviewStatus: dto.review_status } : m
            )
          )
        )
        .catch((err) => setReviewError(errorMessage(err, "Could not save that correction.")));
    },
    [mappings]
  );

  // Teacher corrections to the AI's transcription/feedback — local-only: the
  // API has no route that accepts them, so they last for this session.
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
    assessmentId,
    stage,
    error,
    reviewError,
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
