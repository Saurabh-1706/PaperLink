"use client";

import { useState } from "react";
import type { MappedAnswer, Question } from "@/types";

/**
 * Which question (or unmatched answer) the canvas is showing, plus the
 * accordion and mobile-tab state that moves with it.
 */
export function useQuestionSelection(
  questions: Question[],
  unmatched: MappedAnswer[],
  byQuestion: Map<string | null, MappedAnswer>
) {
  const [selectedId, setSelectedId] = useState<string | null>(questions[0]?.id ?? null);
  const [selectedUnmatchedIdx, setSelectedUnmatchedIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mobileTab, setMobileTab] = useState<"questions" | "sheet">("questions");

  const toggleExpand = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const selectQuestion = (id: string) => {
    setSelectedId(id);
    setSelectedUnmatchedIdx(null);
    setExpanded((p) => ({ ...p, [id]: true }));
    setMobileTab("sheet");
  };

  const selectUnmatched = (index: number) => {
    setSelectedUnmatchedIdx(index);
    setSelectedId(null);
    setMobileTab("sheet");
  };

  const selectedMapping: MappedAnswer | null =
    selectedUnmatchedIdx !== null
      ? unmatched[selectedUnmatchedIdx]
      : (selectedId && byQuestion.get(selectedId)) || null;

  return {
    selectedId,
    selectedUnmatchedIdx,
    expanded,
    mobileTab,
    setMobileTab,
    toggleExpand,
    selectQuestion,
    selectUnmatched,
    selectedMapping,
  };
}
