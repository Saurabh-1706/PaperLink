"use client";

import clsx from "clsx";
import UploadCard from "./UploadCard";

export default function UploadStage({
  questionFile,
  answerFile,
  questionPageCount,
  answerPageCount,
  onQuestionFile,
  onAnswerFile,
  onClearQuestion,
  onClearAnswer,
  onStart,
  disabled,
  error,
}: {
  questionFile: File | null;
  answerFile: File | null;
  questionPageCount?: number;
  answerPageCount?: number;
  onQuestionFile: (f: File) => void;
  onAnswerFile: (f: File) => void;
  onClearQuestion: () => void;
  onClearAnswer: () => void;
  onStart: () => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const canStart = !!questionFile && !!answerFile && !disabled;

  return (
    <div className="flex flex-col w-full h-full justify-center items-center">
      <div className="w-full max-w-4xl px-gutter pt-12 pb-24">
        <div className="text-center mb-16 space-y-4">
          <h1 className="font-headline-xl text-headline-xl text-on-surface">Upload Documents</h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mx-auto">
            Securely drop your answer keys and student submissions here. Our AI will instantly digitize, format, and prepare them for intelligent grading and detailed reporting.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          <UploadCard
            label="Upload Question Paper"
            description="Upload the original question paper (PDF or Images). Our AI will extract all questions and sub-parts automatically."
            badgeText="AI Digitize"
            badgeIcon="auto_awesome"
            mainIcon="fact_check"
            theme="primary"
            file={questionFile}
            pageCount={questionPageCount}
            onFile={onQuestionFile}
            onClear={onClearQuestion}
            disabled={disabled}
          />
          <UploadCard
            label="Student Answer Sheet"
            description="Upload the student's handwritten work. AI will map answers to questions and highlight specific regions."
            badgeText="Single Sheet"
            badgeIcon="person"
            mainIcon="file_copy"
            theme="secondary"
            file={answerFile}
            pageCount={answerPageCount}
            onFile={onAnswerFile}
            onClear={onClearAnswer}
            disabled={disabled}
          />
        </div>

        {error && (
          <div className="w-full mb-8 rounded-xl border border-error bg-error-container p-4 text-center text-sm text-on-error-container font-label-md">
            <span className="material-symbols-outlined mr-2 inline-block align-bottom">error</span>
            {error}
          </div>
        )}

        {canStart && (
          <div className="mt-8 flex justify-center animate-fade-in-up">
            <button
              onClick={onStart}
              className="group flex items-center gap-4 bg-primary text-on-primary px-8 py-4 rounded-full hover:scale-105 active:scale-95 transition-transform shadow-lg shadow-primary/20"
            >
              <div className="text-left">
                <div className="font-headline-md text-headline-md">Start Mapping</div>
              </div>
              <span className="material-symbols-outlined text-[32px] group-hover:translate-x-1 transition-transform">
                arrow_forward
              </span>
            </button>
          </div>
        )}

        <div className="mt-12 flex items-center justify-center gap-6">
          <div className="h-[1px] bg-outline-variant/50 w-16"></div>
          <span className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-widest">
            Alternatively
          </span>
          <div className="h-[1px] bg-outline-variant/50 w-16"></div>
        </div>

        <div className="mt-8 flex justify-center">
          <button className="group flex items-center gap-3 bg-white/80 backdrop-blur-md px-8 py-4 rounded-2xl border border-outline-variant/40 hover:bg-surface-container-low transition-all shadow-sm hover:shadow-md">
            <div className="w-10 h-10 rounded-xl bg-tertiary-container/10 flex items-center justify-center group-hover:bg-tertiary-container/20 transition-colors">
              <span className="material-symbols-outlined text-tertiary">library_books</span>
            </div>
            <div className="text-left">
              <div className="font-label-md text-label-md text-on-surface">Select from Library</div>
              <div className="font-label-sm text-label-sm text-on-surface-variant">
                Use existing documents from past classes
              </div>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant ml-4 group-hover:translate-x-1 transition-transform">
              arrow_forward
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
