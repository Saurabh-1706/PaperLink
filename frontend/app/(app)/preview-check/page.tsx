"use client";

import ReviewWorkspace from "@/features/review/components/ReviewWorkspace";
import type { GradingSummary, MappedAnswer, PageImage, Question } from "@/types";

const PAGE: PageImage = {
  pageIndex: 0,
  dataUrl:
    "data:image/svg+xml;base64," +
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="#fff"/><text x="60" y="120" font-size="28">1. Photosynthesis happens in the chloroplast.</text><text x="60" y="320" font-size="28">2. Mitochondria make ATP.</text></svg>`
    ),
  width: 800,
  height: 1100,
};

const questions: Question[] = [
  { id: "q1", number: "1", text: "Where does photosynthesis take place?", marks: 5, order: 0 },
  { id: "q2", number: "2", text: "What is the role of the mitochondria?", marks: 5, order: 1 },
  { id: "q3", number: "3", text: "Define osmosis.", marks: 5, order: 2 },
];

const mappings: MappedAnswer[] = [
  {
    questionId: "q1",
    questionNumber: "1",
    status: "answered",
    answerText: "Photosynthesis happens in the chloroplast.",
    regions: [{ page: 0, x: 0.07, y: 0.08, width: 0.8, height: 0.06 }],
    isCorrect: true,
    score: 5,
    maxScore: 5,
    feedback: "Correct — names the organelle.",
    confidence: 0.94,
  },
  {
    questionId: "q2",
    questionNumber: "2",
    status: "answered",
    answerText: "Mitochondria make ATP.",
    regions: [{ page: 0, x: 0.07, y: 0.26, width: 0.6, height: 0.06 }],
    isCorrect: null,
    score: 3,
    maxScore: 5,
    feedback: "Partly right; does not mention respiration.",
    confidence: 0.61,
  },
  { questionId: "q3", questionNumber: "3", status: "unanswered" },
];

const unmatched: MappedAnswer[] = [
  {
    questionId: null,
    questionNumber: null,
    status: "unmatched",
    answerText: "Cells are the basic unit of life.",
    regions: [{ page: 0, x: 0.07, y: 0.5, width: 0.7, height: 0.05 }],
  },
];

const summary: GradingSummary = {
  totalQuestions: 3,
  answered: 2,
  unanswered: 1,
  unmatched: 1,
  totalScore: 8,
  maxScore: 15,
  overallFeedback: "Strong on organelles; revise transport processes.",
};

export default function PreviewPage() {
  return (
    <div className="animate-fade-in-up flex-1 flex flex-col h-full min-h-0">
      <ReviewWorkspace
        questions={questions}
        mappings={mappings}
        unmatched={unmatched}
        summary={summary}
        answerPages={[PAGE]}
        onOverrideScore={() => undefined}
        onEditAnswerText={() => undefined}
        onEditFeedback={() => undefined}
      />
    </div>
  );
}
