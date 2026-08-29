"use client";

import type { ProcessingStage } from "@/lib/types";

const STEPS: { key: ProcessingStage; pct: number; text: string; icon: string }[] = [
  { key: "rendering-pages", pct: 15, text: "Reading uploaded pages...", icon: "edit_document" },
  { key: "extracting-questions", pct: 40, text: "Extracting questions & marks...", icon: "plagiarism" },
  { key: "extracting-answers", pct: 70, text: "Scanning handwritten answers...", icon: "find_in_page" },
  { key: "mapping-grading", pct: 92, text: "Mapping & generating feedback...", icon: "analytics" },
];

export default function ExtractingStage({ stage }: { stage: ProcessingStage }) {
  const current = STEPS.find((s) => s.key === stage) ?? STEPS[0];

  return (
    <div className="flex flex-col w-full h-full items-center justify-center p-8 bg-background relative overflow-hidden group min-h-[600px] flex-1">
      {/* Decorative Animated Background Elements */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-container/5 rounded-full blur-3xl -z-10 animate-pulse" style={{ animationDuration: "4s" }}></div>
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-tertiary-fixed/10 rounded-full blur-3xl -z-10 animate-pulse" style={{ animationDuration: "6s", animationDelay: "1s" }}></div>
      
      {/* Dynamic SVG Data Stream Background */}
      <div className="absolute inset-0 w-full h-full -z-20 opacity-20 pointer-events-none">
        <svg className="w-full h-full" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern height="40" id="gridPattern" patternUnits="userSpaceOnUse" width="40">
              <path className="text-outline-variant" d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5"></path>
            </pattern>
            <linearGradient id="scanLine" x1="0%" x2="0%" y1="0%" y2="100%">
              <stop offset="0%" stopColor="transparent"></stop>
              <stop offset="50%" stopColor="#ad2c00" stopOpacity="0.3"></stop>
              <stop offset="100%" stopColor="transparent"></stop>
            </linearGradient>
          </defs>
          <rect fill="url(#gridPattern)" height="100%" width="100%"></rect>
          <rect className="opacity-50" fill="url(#scanLine)" height="10%" width="100%" y="0">
            <animate attributeName="y" dur="8s" repeatCount="indefinite" values="-10%;110%;-10%"></animate>
          </rect>
        </svg>
      </div>
      
      {/* Main Content Container */}
      <div className="flex flex-col items-center justify-center max-w-2xl w-full gap-stack-lg z-10 bg-surface-container-lowest/80 backdrop-blur-xl p-12 rounded-[2rem] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)] border border-surface-container-highest/30 relative">
        <div className="absolute -top-4 -left-4 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center animate-bounce" style={{ animationDuration: "3s" }}>
          <div className="w-2 h-2 rounded-full bg-primary"></div>
        </div>
        <div className="absolute -bottom-6 -right-6 w-12 h-12 rounded-full bg-tertiary/10 flex items-center justify-center animate-bounce" style={{ animationDuration: "4s", animationDelay: "0.5s" }}>
          <div className="w-3 h-3 rounded-full bg-tertiary opacity-50"></div>
        </div>
        
        {/* Central Icon Area */}
        <div className="relative w-40 h-40 flex items-center justify-center mb-stack-md">
          <div className="absolute inset-0 rounded-full border-2 border-dashed border-primary/20 animate-[spin_10s_linear_infinite]"></div>
          <div className="absolute inset-4 rounded-full border border-tertiary-fixed border-t-primary-container animate-[spin_4s_linear_infinite_reverse]"></div>
          <div className="absolute inset-8 rounded-full bg-gradient-to-br from-primary to-primary-container shadow-[0_0_30px_-5px_rgba(215,58,2,0.4)] flex items-center justify-center">
            <span className="material-symbols-outlined text-[48px] text-on-primary transition-all duration-300">
              {current.icon}
            </span>
          </div>
          <div className="absolute top-0 right-0 w-3 h-3 bg-secondary rounded-full animate-ping opacity-75"></div>
          <div className="absolute bottom-4 left-2 w-2 h-2 bg-tertiary rounded-full animate-ping opacity-50" style={{ animationDelay: "0.7s" }}></div>
        </div>
        
        {/* Typography Section */}
        <div className="text-center space-y-stack-xs w-full">
          <h2 className="font-headline-lg text-on-surface tracking-tight">Processing Assessment</h2>
          <div className="h-8 flex items-center justify-center">
            <p className="font-body-lg text-on-surface-variant font-medium animate-fade-in-up transition-opacity duration-300">
              {current.text}
            </p>
          </div>
        </div>
        
        {/* Progress Bar Container */}
        <div className="w-full max-w-md mt-stack-md relative">
          <div className="h-3 w-full bg-surface-container-high rounded-full overflow-hidden shadow-inner relative">
            <div
              className="absolute top-0 left-0 h-full bg-gradient-to-r from-primary-container via-primary to-primary-container bg-[length:200%_100%] rounded-full transition-all duration-700 ease-out"
              style={{ width: `${current.pct}%` }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-[shimmer_2s_infinite]"></div>
            </div>
          </div>
          <div className="absolute -right-14 top-[-6px] w-12 text-right">
            <span className="font-label-md text-primary font-bold">{current.pct}%</span>
          </div>
          
          {/* Micro-status indicators */}
          <div className="flex justify-between mt-stack-xs px-1">
            <span className="font-label-sm text-on-surface-variant/70 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px] text-primary">check_circle</span>
              Ingestion
            </span>
            <span className="font-label-sm text-primary font-bold flex items-center gap-1 animate-pulse">
              <span className="material-symbols-outlined text-[14px]">sync</span>
              Extraction
            </span>
            <span className="font-label-sm text-on-surface-variant/50 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">schedule</span>
              Scoring
            </span>
          </div>
        </div>
      </div>
      
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes fade-in-up {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
          animation: fade-in-up 0.4s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
