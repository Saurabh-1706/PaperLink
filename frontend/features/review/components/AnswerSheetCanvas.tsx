"use client";

import { useEffect, useRef, useState } from "react";
import type { MappedAnswer, PageImage } from "@/types";

export default function AnswerSheetCanvas({
  pages,
  selectedMapping,
}: {
  pages: PageImage[];
  selectedMapping: MappedAnswer | null;
}) {
  const [zoom, setZoom] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!selectedMapping?.regions?.length) return;
    const firstRegion = selectedMapping.regions[0];
    const pageEl = pageRefs.current[firstRegion.page];
    if (!pageEl || !scrollRef.current) return;

    const containerRect = scrollRef.current.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();

    const pageTopInScroll =
      pageRect.top - containerRect.top + scrollRef.current.scrollTop;

    const highlightTopInPage = firstRegion.y * pageRect.height;

    const scrollTo =
      pageTopInScroll +
      highlightTopInPage -
      scrollRef.current.clientHeight * 0.25;

    scrollRef.current.scrollTo({ top: Math.max(0, scrollTo), behavior: "smooth" });
  }, [selectedMapping]);

  if (!pages.length) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-container-low text-label-md text-on-surface-variant">
        No answer sheet loaded
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden relative group">
      {/* ── Floating Toolbar ─────────────────────────────────────────────── */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-white/90 backdrop-blur-md rounded-full shadow-lg px-4 py-2 flex items-center gap-4 z-20 transition-opacity duration-300 opacity-90 hover:opacity-100">
        <button
          onClick={() => setZoom((z) => Math.max(50, z - 15))}
          disabled={zoom <= 50}
          className="p-2 rounded-full hover:bg-surface-container transition-colors text-on-surface-variant disabled:opacity-40"
          title="Zoom Out"
        >
          <span className="material-symbols-outlined text-[20px]">zoom_out</span>
        </button>
        <div className="w-px h-6 bg-outline-variant/50"></div>
        <span className="font-label-sm font-bold w-12 text-center text-on-surface">{zoom}%</span>
        <div className="w-px h-6 bg-outline-variant/50"></div>
        <button
          onClick={() => setZoom((z) => Math.min(200, z + 15))}
          disabled={zoom >= 200}
          className="p-2 rounded-full hover:bg-surface-container transition-colors text-on-surface-variant disabled:opacity-40"
          title="Zoom In"
        >
          <span className="material-symbols-outlined text-[20px]">zoom_in</span>
        </button>
        <button
          onClick={() => setZoom(100)}
          className="p-2 rounded-full hover:bg-surface-container transition-colors text-on-surface-variant ml-2"
          title="Fit to Screen"
        >
          <span className="material-symbols-outlined text-[20px]">fit_screen</span>
        </button>
        <button
          className="p-2 rounded-full hover:bg-primary/10 text-primary transition-colors"
          title="Toggle Highlights"
        >
          <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>visibility</span>
        </button>
      </div>

      {/* ── Continuous scroll page stack ─────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-8 flex flex-col items-center bg-surface-container-low cursor-grab active:cursor-grabbing relative"
      >
        <div className="flex flex-col items-center gap-8 min-h-full pb-32">
          {pages.map((page, idx) => {
            const regionsOnPage = (selectedMapping?.regions ?? []).filter((r) => r.page === idx);

            return (
              <div key={idx} className="relative shrink-0 flex flex-col items-center">
                {pages.length > 1 && (
                  <div className="mb-2 text-center text-[10px] font-bold tracking-widest text-on-surface-variant uppercase">
                    Page {idx + 1}
                  </div>
                )}

                <div
                  ref={(el) => { pageRefs.current[idx] = el; }}
                  className="bg-white shadow-xl relative w-full max-w-[800px] h-fit origin-top transition-transform duration-200"
                  style={{
                    transform: `scale(${zoom / 100})`,
                    marginBottom: zoom !== 100 ? `${(zoom / 100 - 1) * 100}%` : undefined,
                  }}
                >
                  <img
                    src={page.dataUrl}
                    alt={`Answer sheet page ${idx + 1}`}
                    className="block w-full h-auto"
                    draggable={false}
                  />

                  {regionsOnPage.map((r, i) => {
                    const isCorrect = selectedMapping?.isCorrect;
                    let highlightClass = "border-outline border-dashed bg-surface-container-highest/30 hover:bg-surface-container-highest/50";
                    let icon = "edit_note";
                    let iconClass = "text-outline bg-surface-container-highest text-on-surface-variant";
                    let tooltipClass = "bg-surface-container-highest text-on-surface-variant";
                    let tooltipText = `Q${selectedMapping?.questionNumber}: Unanswered`;
                    
                    if (isCorrect === true) {
                      highlightClass = "border-[#16A34A] bg-[#22C55E]/10 shadow-[0_0_15px_rgba(34,197,94,0.3)] hover:bg-[#22C55E]/20";
                      icon = "check";
                      iconClass = "bg-[#16A34A] text-white hidden"; // Hide icon in favor of tooltip
                      tooltipClass = "bg-[#16A34A] text-white";
                      tooltipText = `Q${selectedMapping?.questionNumber}`;
                    } else if (isCorrect === false) {
                      highlightClass = "border-[#DC2626] bg-[#EF4444]/10 shadow-[0_0_15px_rgba(239,68,68,0.3)] hover:bg-[#EF4444]/20";
                      icon = "close";
                      iconClass = "bg-[#DC2626] text-white hidden";
                      tooltipClass = "bg-[#DC2626] text-white";
                      tooltipText = `Q${selectedMapping?.questionNumber}`;
                    } else if (selectedMapping?.status === "answered") {
                      highlightClass = "border-secondary bg-secondary/10 shadow-[0_0_15px_rgba(170,54,18,0.3)] hover:bg-secondary/20";
                      icon = "edit_note";
                      iconClass = "bg-secondary text-white hidden";
                      tooltipClass = "bg-secondary text-white";
                      tooltipText = `Q${selectedMapping?.questionNumber}`;
                    }

                    return (
                      <div
                        key={i}
                        className={`absolute border-2 rounded-lg transition-all duration-200 cursor-pointer pointer-events-auto group flex flex-col items-center justify-center p-2 ${highlightClass}`}
                        style={{
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.width * 100}%`,
                          height: `${r.height * 100}%`,
                        }}
                      >
                        {!isCorrect && selectedMapping?.status !== "answered" && (
                          <span className={`material-symbols-outlined text-outline text-[32px] opacity-50 group-hover:opacity-100 transition-opacity`}>{icon}</span>
                        )}
                        <span className={`font-label-sm text-[10px] px-2 py-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity mt-2 ${tooltipClass}`}>
                          {tooltipText}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── "Spans page X, Y" quick-jump hint ───────────────────── */}
      {(() => {
        if (!selectedMapping?.regions?.length) return null;
        const uniquePages = Array.from(new Set(selectedMapping.regions.map((r) => r.page)));
        if (uniquePages.length <= 1) return null;
        return (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-white/90 backdrop-blur-md rounded-full shadow-lg border border-outline-variant/30 px-6 py-2 z-20 flex items-center gap-2">
            <span className="font-label-sm text-on-surface-variant">
              Answer spans page{uniquePages.length > 1 ? "s" : ""}
            </span>
            <div className="flex gap-1.5">
              {uniquePages.map((p) => (
                <button
                  key={p}
                  className="w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-xs hover:bg-primary hover:text-on-primary transition-colors flex items-center justify-center"
                  onClick={() => {
                    const el = pageRefs.current[p];
                    if (el && scrollRef.current) {
                      const containerRect = scrollRef.current.getBoundingClientRect();
                      const elRect = el.getBoundingClientRect();
                      const target =
                        elRect.top - containerRect.top + scrollRef.current.scrollTop - 32;
                      scrollRef.current.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
                    }
                  }}
                >
                  {p + 1}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Mini Map (Bottom Right) ─────────────────────────────────── */}
      <div className="absolute bottom-4 right-4 w-32 h-48 bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-outline-variant/30 overflow-hidden pointer-events-none z-20">
        <div 
          className="w-full h-full bg-cover bg-center opacity-50" 
          style={{ backgroundImage: `url('${pages[0]?.dataUrl}')` }}
        ></div>
        <div className="absolute top-0 left-0 w-full h-[60%] border-2 border-primary bg-primary/10 rounded-sm"></div>
      </div>
    </div>
  );
}

