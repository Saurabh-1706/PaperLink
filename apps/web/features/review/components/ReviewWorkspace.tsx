"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import AnswerSheetCanvas from "./AnswerSheetCanvas";
import EditableText from "@/components/ui/EditableText";
import { useQuestionFilters, type StatusFilter } from "../hooks/useQuestionFilters";
import { useQuestionSelection } from "../hooks/useQuestionSelection";
import type { GradingSummary, MappedAnswer, PageImage, Question } from "@/types";

function scoreBadgeClasses(mapping?: MappedAnswer) {
  if (!mapping || mapping.status === "unanswered") return "bg-surface-container text-on-surface-variant border-outline-variant";
  if (mapping.isCorrect === true) return "bg-green-100 text-green-800 border-green-200"; // Assuming green for correct is standard, otherwise use semantic token
  if (mapping.isCorrect === false) return "bg-error-container text-error border-error-container";
  return "bg-secondary-container/20 text-secondary border-secondary-container/30";
}

export default function ReviewWorkspace({
  questions,
  mappings,
  unmatched,
  summary,
  answerPages,
  onOverrideScore,
  onEditAnswerText,
  onEditFeedback,
}: {
  questions: Question[];
  mappings: MappedAnswer[];
  unmatched: MappedAnswer[];
  summary: GradingSummary;
  answerPages: PageImage[];
  onOverrideScore: (questionId: string, newScore: number) => void;
  onEditAnswerText: (questionId: string, newText: string) => void;
  onEditFeedback: (questionId: string, newFeedback: string) => void;
}) {
  const { search, setSearch, filter, setFilter, byQuestion, filtered, filteredTree, unansweredQuestions } =
    useQuestionFilters(questions, mappings);

  // Ref to the scrollable question list — used to keep the selected card visible.
  const questionListRef = useRef<HTMLDivElement>(null);

  const {
    selectedId,
    selectedUnmatchedIdx,
    expanded,
    mobileTab,
    setMobileTab,
    toggleExpand,
    selectQuestion,
    selectUnmatched,
    selectedMapping,
    cardRefs,
  } = useQuestionSelection(questions, unmatched, byQuestion, questionListRef);

  const [unmatchedExpanded, setUnmatchedExpanded] = useState(false);
  const [unansweredExpanded, setUnansweredExpanded] = useState(false);

  // Calculate percentages for summary bars
  const totalWeight = questions.length || 1;
  const answeredPct = ((summary.answered || 0) / totalWeight) * 100;
  const unansweredPct = ((summary.unanswered || 0) / totalWeight) * 100;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden px-8 pb-8 bg-background gap-8">
      {/* Mobile tab switcher */}
      <div className="flex shrink-0 items-center justify-center border-b border-outline-variant/30 bg-surface-container-lowest p-2 lg:hidden rounded-t-2xl">
        <div className="flex w-full max-w-sm rounded-xl bg-surface-container p-1">
          {(["questions", "sheet"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setMobileTab(t)}
              aria-pressed={mobileTab === t}
              className={clsx(
                "flex-1 rounded-lg py-1.5 text-xs font-bold transition-[background-color,color] duration-150 ease focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                mobileTab === t ? "bg-white text-on-surface shadow-sm" : "text-on-surface-variant hover:text-on-surface"
              )}
            >
              {t === "questions" ? `Questions (${questions.length})` : "Answer Sheet"}
            </button>
          ))}
        </div>
      </div>

      {/* Both columns are fully independent — each manages its own scroll. The
          grid rows are fixed to h-full so neither column can push the other. */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-0">
        {/* Left Column: List */}
        <div className={clsx(
          "col-span-1 lg:col-span-5 h-full flex flex-col bg-surface-container-lowest rounded-3xl shadow-sm border border-outline-variant/30 overflow-hidden relative",
          mobileTab === "questions" ? "flex" : "hidden lg:flex"
        )}>

          {/* Header Overview */}
          <div className="p-6 border-b border-surface-container-highest/50 flex flex-col gap-4 bg-surface-container-lowest/50">
            <div className="flex justify-between items-end">
              <div>
                <h2 className="font-headline-md text-on-surface tracking-tight">Results Overview</h2>
                <p className="font-label-sm text-on-surface-variant mt-1">Reviewing student submission</p>
              </div>
              <div className="text-right">
                <div className="font-headline-lg text-primary leading-none">{summary.totalScore} / {summary.maxScore ?? "-"}</div>
                <div className="font-label-sm text-primary-fixed-dim uppercase tracking-wider mt-1">Total Marks</div>
              </div>
            </div>

            <div className="space-y-2 mt-2">
              <div className="flex justify-between text-label-sm">
                <span className="text-on-surface-variant font-medium">Processing Status</span>
                <span className="text-on-surface font-bold">{summary.answered} / {questions.length} Analyzed</span>
              </div>
              <div className="h-2 w-full bg-surface-container-high rounded-full overflow-hidden flex">
                <div className="h-full bg-primary" style={{ width: `${answeredPct}%` }} title="Answered"></div>
                <div className="h-full bg-error" style={{ width: `${unansweredPct}%` }} title="Unanswered"></div>
              </div>
            </div>

            {summary.overallFeedback && (
              <div className="mt-2 bg-primary-container/10 border border-primary/20 rounded-xl p-3 flex gap-3">
                <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">auto_awesome</span>
                <p className="font-label-sm text-on-surface-variant leading-relaxed">
                  {summary.overallFeedback}
                </p>
              </div>
            )}
          </div>

          {/* Filters */}
          <div className="p-4 border-b border-surface-container-highest/50 bg-white sticky top-0 z-10 shadow-sm flex items-center justify-between gap-4">
            <div className="relative flex-1">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">search</span>
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant/50 rounded-full py-2 pl-10 pr-4 font-label-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
              />
            </div>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              className="bg-surface-container-low border border-outline-variant/50 rounded-full py-2 px-4 font-label-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer appearance-none"
            >
              <option value="all">All</option>
              <option value="correct">Correct</option>
              <option value="incorrect">Incorrect</option>
              <option value="partial">Answered</option>
              <option value="unanswered">Unanswered</option>
            </select>
          </div>

          {/* Nested question tree — top-level cards contain sub-question chips */}
          <div ref={questionListRef} className="flex-1 overflow-y-auto p-4 space-y-3 pb-24 relative">
            {filteredTree.map(({ parent, children }) => {
              const parentMapping = byQuestion.get(parent.id);
              const isParentSelected = selectedId === parent.id && selectedUnmatchedIdx === null;
              const isParentExpanded = expanded[parent.id] ?? false;
              const parentMaxScore = parentMapping?.maxScore ?? parent.marks ?? 5;
              // A group is "answered" if the parent or any child has an answer
              const groupAnswered =
                (parentMapping && parentMapping.status !== "unanswered") ||
                children.some((c) => {
                  const m = byQuestion.get(c.id);
                  return m && m.status !== "unanswered";
                });

              return (
                <div key={parent.id} className="space-y-1.5">
                  {/* ── Parent / main question card ───────────────────────── */}
                  <div
                    ref={(el) => { cardRefs.current[parent.id] = el; }}
                    onClick={() => selectQuestion(parent.id)}
                    className={clsx(
                      "group bg-white border rounded-2xl p-4 cursor-pointer transition-all duration-200",
                      isParentSelected
                        ? "border-primary shadow-md ring-1 ring-primary/20"
                        : "border-outline-variant/40 hover:border-outline hover:shadow-sm"
                    )}
                  >
                    <div className="flex gap-3">
                      {/* Number badge */}
                      <div className={clsx(
                        "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 font-label-md font-bold transition-colors text-sm",
                        isParentSelected ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
                      )}>
                        {parent.number}
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Meta row */}
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-label-sm text-on-surface-variant uppercase tracking-wider text-[10px]">
                            {children.length > 0 ? `Main Question · ${children.length} part${children.length > 1 ? "s" : ""}` : "Question"}
                          </span>
                          <div className={clsx("px-2 py-0.5 rounded-full font-label-sm text-[10px] flex items-center gap-1", scoreBadgeClasses(parentMapping))}>
                            {parentMapping && parentMapping.status !== "unanswered" ? (
                              <>
                                <span className={clsx("w-1.5 h-1.5 rounded-full", parentMapping.isCorrect ? "bg-green-500" : parentMapping.isCorrect === false ? "bg-red-500" : "bg-orange-500")} />
                                {parentMapping.isCorrect ? "Correct" : parentMapping.isCorrect === false ? "Incorrect" : "Answered"}
                                {" "}({typeof parentMapping.score === "number" ? parentMapping.score : "–"} / {parentMaxScore})
                              </>
                            ) : children.length > 0 ? (
                              <>
                                <span className={clsx("w-1.5 h-1.5 rounded-full", groupAnswered ? "bg-orange-400" : "bg-outline-variant")} />
                                {groupAnswered ? "Parts answered" : "Unanswered"}
                              </>
                            ) : (
                              <>
                                <span className="w-1.5 h-1.5 rounded-full bg-outline-variant" />
                                Unanswered
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-start justify-between gap-2">
                          <h4 className={clsx(
                            "font-body-md text-on-surface leading-snug transition-colors flex-1",
                            isParentSelected ? "text-primary font-semibold" : "group-hover:text-primary"
                          )}>
                            {parent.text}
                          </h4>

                          <div className="flex items-center gap-1 shrink-0">
                            {parentMapping && parentMapping.status !== "unanswered" && parentMapping.regions?.length ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); selectQuestion(parent.id); }}
                                title="Jump to answer in sheet"
                                className={clsx(
                                  "w-7 h-7 rounded-full flex items-center justify-center transition-colors text-on-surface-variant hover:bg-primary/10 hover:text-primary",
                                  isParentSelected && "text-primary"
                                )}
                              >
                                <span className="material-symbols-outlined text-[17px]">my_location</span>
                              </button>
                            ) : null}
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleExpand(parent.id); }}
                              className={clsx(
                                "w-7 h-7 rounded-full flex items-center justify-center transition-colors text-on-surface-variant hover:bg-surface-container",
                                isParentSelected && "bg-primary-container/10 text-primary"
                              )}
                            >
                              <span className={clsx("material-symbols-outlined text-[20px] transition-transform duration-300", isParentExpanded ? "rotate-180" : "")}>expand_more</span>
                            </button>
                          </div>
                        </div>

                        {/* Expandable detail for parent */}
                        <div className="accordion-rows" data-open={isParentExpanded}>
                          <div className="pt-4 space-y-3">
                            {parentMapping && parentMapping.status !== "unanswered" && (
                              <div className="bg-surface-container-low rounded-xl p-3 border border-outline-variant/30">
                                <div className="font-label-sm text-on-surface-variant mb-1 flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[14px]">edit_document</span>
                                  Student Answer
                                </div>
                                <EditableText
                                  value={parentMapping.answerText ?? ""}
                                  onSave={(next) => onEditAnswerText(parent.id, next)}
                                  ariaLabel={`transcribed answer for question ${parent.number}`}
                                  textClassName="font-body-sm text-on-surface"
                                />
                              </div>
                            )}
                            {parentMapping && parentMapping.status !== "unanswered" && (
                              <div className="bg-primary-container/5 rounded-xl p-3 border border-primary/20">
                                <div className="font-label-sm text-primary mb-1 flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                                  AI Rationale
                                </div>
                                <EditableText
                                  value={parentMapping.feedback ?? ""}
                                  onSave={(next) => onEditFeedback(parent.id, next)}
                                  emptyLabel="Click to add feedback…"
                                  ariaLabel={`feedback for question ${parent.number}`}
                                  textClassName="font-body-sm text-on-surface"
                                />
                              </div>
                            )}
                            {(!parentMapping || parentMapping.status === "unanswered") && children.length === 0 && (
                              <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-3 text-xs italic text-on-surface-variant">
                                No matching answer was found on the answer sheet for this question.
                              </div>
                            )}
                            {parentMapping && parentMapping.status !== "unanswered" && (
                              <div className="pt-2 border-t border-outline-variant/30 flex items-center justify-between">
                                <span className="font-label-sm text-on-surface-variant">Override Score:</span>
                                <div className="flex gap-1">
                                  {[...Array(parentMaxScore + 1)].map((_, i) => (
                                    <button
                                      key={i}
                                      onClick={(e) => { e.stopPropagation(); onOverrideScore(parent.id, i); }}
                                      className={clsx(
                                        "w-7 h-7 rounded-lg font-label-md transition-colors",
                                        parentMapping.score === i ? "bg-primary text-on-primary shadow-sm" : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                                      )}
                                    >{i}</button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── Sub-question chips (nested, indented) ─────────────── */}
                  {children.length > 0 && (
                    <div className="ml-5 pl-3 border-l-2 border-outline-variant/30 space-y-1.5">
                      {children.map((child) => {
                        const childMapping = byQuestion.get(child.id);
                        const isChildSelected = selectedId === child.id && selectedUnmatchedIdx === null;
                        const isChildExpanded = expanded[child.id] ?? false;
                        const childMaxScore = childMapping?.maxScore ?? child.marks ?? 5;

                        return (
                          <div
                            key={child.id}
                            ref={(el) => { cardRefs.current[child.id] = el; }}
                            onClick={() => selectQuestion(child.id)}
                            className={clsx(
                              "group bg-white border rounded-xl p-3 cursor-pointer transition-all duration-150",
                              isChildSelected
                                ? "border-primary shadow-sm ring-1 ring-primary/20"
                                : "border-outline-variant/30 hover:border-outline hover:shadow-sm"
                            )}
                          >
                            <div className="flex gap-2.5">
                              {/* Sub-question number badge — smaller, pill shape */}
                              <div className={clsx(
                                "min-w-[28px] h-7 px-1.5 rounded-lg flex items-center justify-center shrink-0 font-label-sm font-bold transition-colors text-xs",
                                isChildSelected ? "bg-primary text-on-primary" : "bg-primary/10 text-primary"
                              )}>
                                {child.number}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-0.5">
                                  <span className="font-label-sm text-on-surface-variant uppercase tracking-wider text-[9px]">Sub-question</span>
                                  <div className={clsx("px-1.5 py-0.5 rounded-full font-label-sm text-[9px] flex items-center gap-1", scoreBadgeClasses(childMapping))}>
                                    {childMapping && childMapping.status !== "unanswered" ? (
                                      <>
                                        <span className={clsx("w-1 h-1 rounded-full", childMapping.isCorrect ? "bg-green-500" : childMapping.isCorrect === false ? "bg-red-500" : "bg-orange-500")} />
                                        {childMapping.isCorrect ? "Correct" : childMapping.isCorrect === false ? "Incorrect" : "Answered"}
                                        {" "}({typeof childMapping.score === "number" ? childMapping.score : "–"}/{childMaxScore})
                                      </>
                                    ) : (
                                      <>
                                        <span className="w-1 h-1 rounded-full bg-outline-variant" />
                                        Unanswered
                                      </>
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-start justify-between gap-1">
                                  <p className={clsx(
                                    "font-body-sm text-on-surface leading-snug flex-1 transition-colors",
                                    isChildSelected ? "text-primary font-medium" : "group-hover:text-primary"
                                  )}>
                                    {child.text}
                                  </p>
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    {childMapping && childMapping.status !== "unanswered" && childMapping.regions?.length ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); selectQuestion(child.id); }}
                                        title="Jump to answer"
                                        className={clsx(
                                          "w-6 h-6 rounded-full flex items-center justify-center transition-colors text-on-surface-variant hover:bg-primary/10 hover:text-primary",
                                          isChildSelected && "text-primary"
                                        )}
                                      >
                                        <span className="material-symbols-outlined text-[15px]">my_location</span>
                                      </button>
                                    ) : null}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); toggleExpand(child.id); }}
                                      className="w-6 h-6 rounded-full flex items-center justify-center transition-colors text-on-surface-variant hover:bg-surface-container"
                                    >
                                      <span className={clsx("material-symbols-outlined text-[18px] transition-transform duration-200", isChildExpanded ? "rotate-180" : "")}>expand_more</span>
                                    </button>
                                  </div>
                                </div>

                                {/* Expandable detail for sub-question */}
                                <div className="accordion-rows" data-open={isChildExpanded}>
                                  <div className="pt-3 space-y-2">
                                    {childMapping && childMapping.status !== "unanswered" && (
                                      <div className="bg-surface-container-low rounded-lg p-2.5 border border-outline-variant/30">
                                        <div className="font-label-sm text-on-surface-variant mb-1 flex items-center gap-1">
                                          <span className="material-symbols-outlined text-[13px]">edit_document</span>
                                          Student Answer
                                        </div>
                                        <EditableText
                                          value={childMapping.answerText ?? ""}
                                          onSave={(next) => onEditAnswerText(child.id, next)}
                                          ariaLabel={`transcribed answer for ${child.number}`}
                                          textClassName="font-body-sm text-on-surface"
                                        />
                                      </div>
                                    )}
                                    {childMapping && childMapping.status !== "unanswered" && (
                                      <div className="bg-primary-container/5 rounded-lg p-2.5 border border-primary/20">
                                        <div className="font-label-sm text-primary mb-1 flex items-center gap-1">
                                          <span className="material-symbols-outlined text-[13px]">auto_awesome</span>
                                          AI Rationale
                                        </div>
                                        <EditableText
                                          value={childMapping.feedback ?? ""}
                                          onSave={(next) => onEditFeedback(child.id, next)}
                                          emptyLabel="Click to add feedback…"
                                          ariaLabel={`feedback for ${child.number}`}
                                          textClassName="font-body-sm text-on-surface"
                                        />
                                      </div>
                                    )}
                                    {(!childMapping || childMapping.status === "unanswered") && (
                                      <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-2.5 text-xs italic text-on-surface-variant">
                                        No matching answer found for this sub-question.
                                      </div>
                                    )}
                                    {childMapping && childMapping.status !== "unanswered" && (
                                      <div className="pt-1.5 border-t border-outline-variant/30 flex items-center justify-between">
                                        <span className="font-label-sm text-on-surface-variant text-xs">Override:</span>
                                        <div className="flex gap-1">
                                          {[...Array(childMaxScore + 1)].map((_, i) => (
                                            <button
                                              key={i}
                                              onClick={(e) => { e.stopPropagation(); onOverrideScore(child.id, i); }}
                                              className={clsx(
                                                "w-6 h-6 rounded-md font-label-sm text-xs transition-colors",
                                                childMapping.score === i ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                                              )}
                                            >{i}</button>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Unmatched / Unanswered Sections */}
            {(unmatched.length > 0 || unansweredQuestions.length > 0) && (
              <div className="mt-6 space-y-3">
                {unansweredQuestions.length > 0 && (
                  <div className="bg-surface-container-lowest border border-error/20 rounded-2xl overflow-hidden">
                    <button
                      onClick={() => setUnansweredExpanded(!unansweredExpanded)}
                      className="w-full p-4 flex items-center justify-between bg-error/5 hover:bg-error/10 transition-colors"
                    >
                      <div className="flex items-center gap-2 text-error font-label-md">
                        <span className="material-symbols-outlined text-[18px]">warning</span>
                        {unansweredQuestions.length} Missing Answers
                      </div>
                      <span className={clsx("material-symbols-outlined text-error transition-transform", unansweredExpanded && "rotate-180")}>expand_more</span>
                    </button>
                    {unansweredExpanded && (
                      <div className="p-3 border-t border-error/10 space-y-2 max-h-48 overflow-y-auto">
                        {unansweredQuestions.map((q) => (
                          <button
                            key={q.id}
                            onClick={() => selectQuestion(q.id)}
                            className={clsx(
                              "w-full text-left p-3 rounded-xl border text-sm transition-colors",
                              selectedId === q.id && selectedUnmatchedIdx === null ? "border-primary bg-primary/5" : "border-outline-variant/30 bg-surface-container-lowest hover:border-outline"
                            )}
                          >
                            <span className="font-bold text-on-surface-variant text-xs">Q{q.number}</span>
                            <p className="line-clamp-1 text-on-surface mt-1">{q.text}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {unmatched.length > 0 && (
                  <div className="bg-surface-container-lowest border border-secondary/20 rounded-2xl overflow-hidden">
                    <button
                      onClick={() => setUnmatchedExpanded(!unmatchedExpanded)}
                      className="w-full p-4 flex items-center justify-between bg-secondary/5 hover:bg-secondary/10 transition-colors"
                    >
                      <div className="flex items-center gap-2 text-secondary font-label-md">
                        <span className="material-symbols-outlined text-[18px]">help_center</span>
                        {unmatched.length} Unmatched Answers
                      </div>
                      <span className={clsx("material-symbols-outlined text-secondary transition-transform", unmatchedExpanded && "rotate-180")}>expand_more</span>
                    </button>
                    {unmatchedExpanded && (
                      <div className="p-3 border-t border-secondary/10 space-y-2 max-h-48 overflow-y-auto">
                        {unmatched.map((m, i) => (
                          <button
                            key={i}
                            onClick={() => selectUnmatched(i)}
                            className={clsx(
                              "w-full text-left p-3 rounded-xl border text-sm transition-colors",
                              selectedUnmatchedIdx === i ? "border-primary bg-primary/5" : "border-outline-variant/30 bg-surface-container-lowest hover:border-outline"
                            )}
                          >
                            <span className="font-bold text-on-surface-variant text-xs">{m.questionNumber ? `Labelled "${m.questionNumber}"` : "No label found"}</span>
                            <p className="line-clamp-1 text-on-surface mt-1">{m.answerText}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Decorative fade at bottom of list */}
            <div className="absolute bottom-0 left-0 w-full h-12 bg-gradient-to-t from-surface-container-lowest to-transparent pointer-events-none rounded-b-3xl"></div>
          </div>
        </div>

        {/* Right Column: Answer Sheet */}
        <div className={clsx(
          "col-span-1 lg:col-span-7 h-full bg-surface-container rounded-3xl shadow-sm border border-outline-variant/30 overflow-hidden relative",
          mobileTab === "sheet" ? "flex" : "hidden lg:flex"
        )}>
          <AnswerSheetCanvas pages={answerPages} selectedMapping={selectedMapping} />
        </div>
      </div>
    </div>
  );
}
