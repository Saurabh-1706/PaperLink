"use client";

import { useMemo, useState } from "react";
import type { MappedAnswer, Question } from "@/types";

export type StatusFilter = "all" | "correct" | "partial" | "incorrect" | "unanswered";

/**
 * Search + status filtering for the question list. Pure derivation from the
 * mappings — no side effects, so it is testable on its own.
 */
export function useQuestionFilters(questions: Question[], mappings: MappedAnswer[]) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const byQuestion = useMemo(
    () => new Map(mappings.map((m) => [m.questionId, m])),
    [mappings]
  );

  const filtered = useMemo(
    () =>
      questions.filter((q) => {
        const needle = search.toLowerCase();
        const matchesSearch =
          q.text.toLowerCase().includes(needle) ||
          `question ${q.number}`.toLowerCase().includes(needle);
        if (!matchesSearch) return false;
        if (filter === "all") return true;
        const m = byQuestion.get(q.id);
        if (filter === "unanswered") return !m || m.status === "unanswered";
        if (filter === "correct") return m?.isCorrect === true;
        if (filter === "incorrect") return m?.isCorrect === false;
        if (filter === "partial") return m?.status === "answered" && m.isCorrect == null;
        return true;
      }),
    [questions, search, filter, byQuestion]
  );

  const unansweredQuestions = useMemo(
    () =>
      questions.filter((q) => {
        const m = byQuestion.get(q.id);
        return !m || m.status === "unanswered";
      }),
    [questions, byQuestion]
  );

  return { search, setSearch, filter, setFilter, byQuestion, filtered, unansweredQuestions };
}
