"use client";

import ExtractingStage from "@/features/processing/components/ExtractingStage";
import ReviewWorkspace from "@/features/review/components/ReviewWorkspace";
import UploadStage from "@/features/upload/components/UploadStage";
import { useAssessment } from "../store/AssessmentProvider";

/**
 * The upload → processing → review flow. One route, three stages. The run is
 * persisted by the API, so what is held here is recoverable rather than lost on
 * refresh — see `assessmentId` on the store.
 */
export default function AssessmentWorkflow() {
  const {
    questionFiles,
    answerFiles,
    questionPages,
    answerPages,
    stage,
    error,
    reviewError,
    questions,
    mappings,
    unmatched,
    summary,
    isProcessing,
    isComplete,
    setQuestionFiles,
    setAnswerFiles,
    clearQuestionFile,
    clearAnswerFile,
    process,
    reset,
    overrideScore,
    editAnswerText,
    editFeedback,
  } = useAssessment();

  return (
    <>
      {!isComplete && stage !== "error" && (
        <div key={isProcessing ? "extracting" : "upload"} className="animate-fade-in-up flex-1 flex flex-col">
          {isProcessing ? (
            <ExtractingStage stage={stage} />
          ) : (
            <UploadStage
              questionFiles={questionFiles}
              answerFiles={answerFiles}
              questionPageCount={questionPages.length || undefined}
              answerPageCount={answerPages.length || undefined}
              onQuestionFiles={setQuestionFiles}
              onAnswerFiles={setAnswerFiles}
              onClearQuestion={clearQuestionFile}
              onClearAnswer={clearAnswerFile}
              onStart={process}
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

      {isComplete && summary && (
        <div className="animate-fade-in-up flex-1 flex flex-col h-full min-h-0">
          {reviewError && (
            <div
              role="status"
              className="mx-8 mb-4 rounded-xl border border-error bg-error-container px-4 py-2 text-sm text-on-error-container"
            >
              <span className="material-symbols-outlined mr-2 inline-block align-bottom text-[18px]">
                cloud_off
              </span>
              {reviewError}
            </div>
          )}
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
    </>
  );
}
