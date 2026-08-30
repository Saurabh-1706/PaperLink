"use client";

import { useRef, useState } from "react";
import type { MappedAnswer, Question } from "@/types";

/**
 * Which question (or unmatched answer) the canvas is showing, plus the
 * accordion and mobile-tab state that moves with it.
 *
 * @param questionListRef - ref to the scrollable question list container.
 *   When a question is selected, the hook scrolls its card into view so the
 *   user always sees which question corresponds to the highlighted answer region.
 */
export function useQuestionSelection(
  questions: Question[],
  unmatched: MappedAnswer[],
  byQuestion: Map<string | null, MappedAnswer>,
  questionListRef?: React.RefObject<HTMLDivElement | null>
) {
  const [selectedId, setSelectedId] = useState<string | null>(questions[0]?.id ?? null);
  const [selectedUnmatchedIdx, setSelectedUnmatchedIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mobileTab, setMobileTab] = useState<"questions" | "sheet">("questions");

  // Keep a map of question-id → DOM card element so we can scroll it into view.
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  const toggleExpand = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const scrollCardIntoView = (id: string) => {
    const listEl = questionListRef?.current;
    const cardEl = cardRefs.current[id];
    if (!listEl || !cardEl) return;

    const listRect = listEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const cardTopInList = cardRect.top - listRect.top + listEl.scrollTop;

    // Centre the card in the visible list area with a bit of top padding.
    const targetScroll = cardTopInList - listEl.clientHeight * 0.2;
    listEl.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
  };

  const selectQuestion = (id: string) => {
    setSelectedId(id);
    setSelectedUnmatchedIdx(null);
    setExpanded((p) => ({ ...p, [id]: true }));
    setMobileTab("sheet");
    // Scroll the selected card into view in the question list.
    scrollCardIntoView(id);
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
    /** Attach this to each question card's ref to enable auto-scroll. */
    cardRefs,
  };
}
