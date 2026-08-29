"use client";

import { useState } from "react";
import clsx from "clsx";
import AnswerSheetCanvas from "./AnswerSheetCanvas";
import EditableText from "@/components/ui/EditableText";
import { useHasPermission } from "@/features/auth/hooks/useAuth";
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
  const { search, setSearch, filter, setFilter, byQuestion, filtered, unansweredQuestions } =
    useQuestionFilters(questions, mappings);
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
  } = useQuestionSelection(questions, unmatched, byQuestion);

  // Grading changes marks and feedback; correcting a transcription is review
  // work. A Reviewer holds the latter but not the former (docs/05-rbac.md).
  const canGrade = useHasPermission("grade");
  const canReview = useHasPermission("review_mapping");

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

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">
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

          {/* List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-24 relative">
            {filtered.map((q) => {
              const mapping = byQuestion.get(q.id);
              const isSelected = selectedId === q.id && selectedUnmatchedIdx === null;
              const isExpanded = expanded[q.id] ?? false;
              const maxScore = mapping?.maxScore ?? q.marks ?? 5;

              return (
                <div
                  key={q.id}
                  onClick={() => selectQuestion(q.id)}
                  className={clsx(
                    "group bg-white border rounded-2xl p-4 cursor-pointer transition-all duration-200",
                    isSelected ? "border-primary shadow-md ring-1 ring-primary/20" : "border-outline-variant/40 hover:border-outline hover:shadow-sm"
                  )}
                >
                  <div className="flex gap-4">
                    <div className={clsx(
                      "w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-label-md font-bold transition-colors",
                      isSelected ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
                    )}>
                      {q.number}
                    </div>
                    <div className="flex-1 min-w-0">
                      {/* Meta/Score row */}
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-label-sm text-on-surface-variant uppercase tracking-wider text-[10px]">Question</span>
                        <div className={clsx("px-2 py-0.5 rounded-full font-label-sm text-[10px] flex items-center gap-1", scoreBadgeClasses(mapping))}>
                          {mapping && mapping.status !== "unanswered" ? (
                            <>
                              <span className={clsx("w-1.5 h-1.5 rounded-full", mapping.isCorrect ? "bg-green-500" : mapping.isCorrect === false ? "bg-red-500" : "bg-orange-500")}></span>
                              {mapping.isCorrect ? "Correct" : mapping.isCorrect === false ? "Incorrect" : "Answered"} ({typeof mapping.score === "number" ? mapping.score : "–"} / {maxScore})
                            </>
                          ) : (
                            <>
                              <span className="w-1.5 h-1.5 rounded-full bg-outline-variant"></span>
                              Unanswered
                            </>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <h4 className={clsx("font-body-md text-on-surface leading-snug truncate transition-colors", isSelected ? "text-primary font-semibold" : "group-hover:text-primary")}>
                          {q.text}
                        </h4>
                        
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(q.id);
                          }}
                          className={clsx(
                            "w-8 h-8 rounded-full flex items-center justify-center transition-colors text-on-surface-variant hover:bg-surface-container hover:text-on-surface shrink-0 ml-2",
                            isSelected && "bg-primary-container/10 text-primary hover:bg-primary-container/20"
                          )}
                        >
                          <span className={clsx(
                            "material-symbols-outlined transition-transform duration-300",
                            isExpanded ? "rotate-180" : ""
                          )}>expand_more</span>
                        </button>
                      </div>

                      {/* Expandable Content */}
                      <div className="accordion-rows" data-open={isExpanded}>
                        <div className="pt-4 space-y-4">
                          {mapping && mapping.status !== "unanswered" && (
                            <div className="bg-surface-container-low rounded-xl p-3 border border-outline-variant/30">
                              <div className="font-label-sm text-on-surface-variant mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-[14px]">edit_document</span>
                                Student Answer
                              </div>
                              <EditableText
                                value={mapping.answerText ?? ""}
                                onSave={(next) => onEditAnswerText(q.id, next)}
                                ariaLabel={`transcribed answer for question ${q.number}`}
                                textClassName="font-body-sm text-on-surface"
                                readOnly={!canReview}
                              />
                            </div>
                          )}

                          {mapping && mapping.status !== "unanswered" && (
                            <div className="bg-primary-container/5 rounded-xl p-3 border border-primary/20">
                              <div className="font-label-sm text-primary mb-1 flex items-center gap-1">
                                <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                                AI Rationale
                              </div>
                              <EditableText
                                value={mapping.feedback ?? ""}
                                onSave={(next) => onEditFeedback(q.id, next)}
                                emptyLabel="Click to add feedback…"
                                ariaLabel={`feedback for question ${q.number}`}
                                textClassName="font-body-sm text-on-surface"
                                readOnly={!canGrade}
                              />
                            </div>
                          )}

                          {(!mapping || mapping.status === "unanswered") && (
                            <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-3 text-xs italic text-on-surface-variant">
                              No matching answer was found on the answer sheet for this question.
                            </div>
                          )}

                          {/* Overriding a score is grading — a Reviewer resolves
                              mappings but never changes marks. */}
                          {mapping && mapping.status !== "unanswered" && (
                            canGrade && (
                              <div className="pt-2 border-t border-outline-variant/30 flex items-center justify-between">
                                <span className="font-label-sm text-on-surface-variant">Override Score:</span>
                                <div className="flex gap-1">
                                  {[...Array(maxScore + 1)].map((_, i) => (
                                    <button
                                      key={i}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onOverrideScore(q.id, i);
                                      }}
                                      className={clsx(
                                        "w-7 h-7 rounded-lg font-label-md transition-colors",
                                        mapping.score === i
                                          ? "bg-primary text-on-primary shadow-sm"
                                          : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                                      )}
                                    >
                                      {i}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
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
