"use client";

import { useMemo, useState } from "react";
import type { MappedAnswer, Question } from "@/types";

export type StatusFilter = "all" | "correct" | "partial" | "incorrect" | "unanswered";

/** A top-level question with its sub-questions nested inside. */
export interface QuestionGroup {
  parent: Question;
  children: Question[]; // ordered sub-parts (e.g. 1a, 1b, 1c)
}

/**
 * Search + status filtering for the question list. Pure derivation from the
 * mappings — no side effects, so it is testable on its own.
 *
 * Returns questions structured as a nested tree: top-level questions with their
 * sub-parts nested inside (QuestionGroup[]). Orphan sub-parts (parent missing)
 * are surfaced as standalone top-level groups so nothing is lost.
 */
export function useQuestionFilters(questions: Question[], mappings: MappedAnswer[]) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const byQuestion = useMemo(
    () => new Map(mappings.map((m) => [m.questionId, m])),
    [mappings]
  );

  /** All questions indexed by id for O(1) parent lookup. */
  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);

  /** Nested tree: top-level questions → children sorted by order. */
  const tree = useMemo((): QuestionGroup[] => {
    const topLevel = questions.filter((q) => !q.parentId || !byId.has(q.parentId));
    const childrenByParent = new Map<string, Question[]>();

    for (const q of questions) {
      if (q.parentId && byId.has(q.parentId)) {
        const siblings = childrenByParent.get(q.parentId) ?? [];
        siblings.push(q);
        childrenByParent.set(q.parentId, siblings);
      }
    }

    return topLevel
      .sort((a, b) => a.order - b.order)
      .map((parent) => ({
        parent,
        children: (childrenByParent.get(parent.id) ?? []).sort((a, b) => a.order - b.order),
      }));
  }, [questions, byId]);

  /** Match a question (or any of its children) against the active search + filter. */
  const matchesFilter = (q: Question): boolean => {
    const needle = search.toLowerCase();
    const matchesSearch =
      !needle ||
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
  };

  /**
   * Filtered tree: a group is kept if the parent matches OR any child matches.
   * Children that don't individually match are removed from the group.
   */
  const filteredTree = useMemo((): QuestionGroup[] => {
    return tree
      .map(({ parent, children }) => {
        const parentMatches = matchesFilter(parent);
        const matchingChildren = children.filter(matchesFilter);
        if (!parentMatches && matchingChildren.length === 0) return null;
        return {
          parent,
          // If parent matches, show all children (context); otherwise only matching ones.
          children: parentMatches ? children : matchingChildren,
        };
      })
      .filter((g): g is QuestionGroup => g !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, search, filter, byQuestion]);

  /** Flat list of all questions that are currently filtered — used by legacy callers. */
  const filtered = useMemo(
    () => filteredTree.flatMap(({ parent, children }) => [parent, ...children]),
    [filteredTree]
  );

  const unansweredQuestions = useMemo(
    () =>
      questions.filter((q) => {
        const m = byQuestion.get(q.id);
        return !m || m.status === "unanswered";
      }),
    [questions, byQuestion]
  );

  return {
    search,
    setSearch,
    filter,
    setFilter,
    byQuestion,
    /** Nested tree — use this for the new grouped list UI. */
    filteredTree,
    /** Flat filtered list — kept for backwards compatibility. */
    filtered,
    unansweredQuestions,
  };
}
