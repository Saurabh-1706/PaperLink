"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import BackgroundGlow from "@/components/BackgroundGlow";
import UploadStage from "@/components/UploadStage";
import ExtractingStage from "@/components/ExtractingStage";
import ReviewWorkspace from "@/components/ReviewWorkspace";
import { fileToPageImages } from "@/lib/pdf";
import { addCoordinateGrid } from "@/lib/gridOverlay";
import type { GradingSummary, MappedAnswer, PageImage, ProcessingStage, Question, RawAnswerBlock } from "@/lib/types";

export default function Home() {
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [questionPages, setQuestionPages] = useState<PageImage[]>([]);
  const [answerPages, setAnswerPages] = useState<PageImage[]>([]);

  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [mappings, setMappings] = useState<MappedAnswer[]>([]);
  const [unmatched, setUnmatched] = useState<MappedAnswer[]>([]);
  const [summary, setSummary] = useState<GradingSummary | null>(null);

  async function handleProcess() {
    if (!questionFile || !answerFile) return;
    setError(null);
    setStage("rendering-pages");
    try {
      const [qPages, aPages] = await Promise.all([fileToPageImages(questionFile), fileToPageImages(answerFile)]);
      setQuestionPages(qPages);
      setAnswerPages(aPages);

      setStage("extracting-questions");
      const qRes = await fetch("/api/extract-questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages: qPages }),
      });
      const qData = await qRes.json();
      if (!qRes.ok) throw new Error(qData.error);
      setQuestions(qData.questions);

      setStage("extracting-answers");
      // Gemini has native bounding-box grounding and doesn't need (or want —
      // it's just visual clutter) the grid crutch other providers need. Ask
      // which provider actually handles answer extraction (it can differ from
      // the main provider — see ANSWER_PROVIDER) before deciding whether to
      // overlay it.
      const configRes = await fetch("/api/config");
      const { answerProvider } = await configRes.json();
      const answerPagesForApi =
        answerProvider === "gemini" ? aPages : await Promise.all(aPages.map((p) => addCoordinateGrid(p)));
      const aRes = await fetch("/api/extract-answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages: answerPagesForApi, questions: qData.questions }),
      });
      const aData = await aRes.json();
      if (!aRes.ok) throw new Error(aData.error);
      const rawAnswers: RawAnswerBlock[] = aData.rawAnswers;

      setStage("mapping-grading");
      const gRes = await fetch("/api/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: qData.questions, rawAnswers }),
      });
      const gData = await gRes.json();
      if (!gRes.ok) throw new Error(gData.error);

      const all: MappedAnswer[] = Array.isArray(gData.mappings) ? gData.mappings : [];
      setMappings(all.filter((m) => m.status !== "unmatched"));
      setUnmatched(all.filter((m) => m.status === "unmatched"));
      setSummary(gData.summary);
      setStage("done");
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      setStage("error");
    }
  }

  function reset() {
    setQuestionFile(null);
    setAnswerFile(null);
    setQuestionPages([]);
    setAnswerPages([]);
    setQuestions([]);
    setMappings([]);
    setUnmatched([]);
    setSummary(null);
    setStage("idle");
    setError(null);
  }

  function overrideScore(questionId: string, newScore: number) {
    setMappings((prev) =>
      prev.map((m) => {
        if (m.questionId !== questionId) return m;
        const maxScore = m.maxScore ?? 5;
        return { ...m, score: newScore, isCorrect: newScore === maxScore ? true : newScore === 0 ? false : null };
      })
    );
    setMappings((prev) => {
      const updated = prev.map((m) => {
        if (m.questionId !== questionId) return m;
        const maxScore = m.maxScore ?? 5;
        return { ...m, score: newScore, isCorrect: newScore === maxScore ? true : newScore === 0 ? false : null };
      });
      setSummary((prevSummary) => {
        if (!prevSummary) return prevSummary;
        const graded = updated.filter((m) => typeof m.score === "number" && typeof m.maxScore === "number");
        return { ...prevSummary, totalScore: graded.reduce((s, m) => s + (m.score ?? 0), 0) };
      });
      return updated;
    });
  }

  // Teacher corrections to the AI's transcription/feedback — local-only, the
  // AI's original output isn't re-sent anywhere, this just overrides what's shown.
  function editAnswerText(questionId: string, newText: string) {
    setMappings((prev) => prev.map((m) => (m.questionId === questionId ? { ...m, answerText: newText } : m)));
  }

  function editFeedback(questionId: string, newFeedback: string) {
    setMappings((prev) => prev.map((m) => (m.questionId === questionId ? { ...m, feedback: newFeedback } : m)));
  }

  const processing = stage !== "idle" && stage !== "done" && stage !== "error";
  const showResults = stage === "done";

  return (
    <>
      <Sidebar mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <div className="md:pl-72 w-full min-h-screen flex flex-col">
        <Header onOpenMenu={() => setMobileNavOpen(true)} />

        <main className="flex-1 w-full flex flex-col pt-4 md:pt-0">
          {!showResults && stage !== "error" && (
            <div key={processing ? "extracting" : "upload"} className="animate-fade-in-up flex-1 flex flex-col">
              {processing ? (
                <ExtractingStage stage={stage} />
              ) : (
                <UploadStage
                  questionFile={questionFile}
                  answerFile={answerFile}
                  questionPageCount={questionPages.length || undefined}
                  answerPageCount={answerPages.length || undefined}
                  onQuestionFile={setQuestionFile}
                  onAnswerFile={setAnswerFile}
                  onClearQuestion={() => setQuestionFile(null)}
                  onClearAnswer={() => setAnswerFile(null)}
                  onStart={handleProcess}
                  error={error}
                />
              )}
            </div>
          )}

          {stage === "error" && (
            <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-4 px-6">
              <p className="rounded-xl border border-error bg-error-container px-4 py-3 text-sm text-on-error-container">
                <span className="material-symbols-outlined mr-2 inline-block align-bottom">error</span>
                {error}
              </p>
              <button
                onClick={reset}
                className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium tracking-tight text-on-primary transition-transform hover:scale-105 active:scale-95 shadow-md"
              >
                <span className="material-symbols-outlined text-[20px]">refresh</span>
                Try again
              </button>
            </div>
          )}

          {showResults && summary && (
            <div className="animate-fade-in-up flex-1 flex flex-col h-full min-h-0">
              <ReviewWorkspace
                questions={questions}
                mappings={mappings}
                unmatched={unmatched}
                summary={summary}
                answerPages={answerPages}
                onOverrideScore={overrideScore}
                onEditAnswerText={editAnswerText}
                onEditFeedback={editFeedback}
              />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
