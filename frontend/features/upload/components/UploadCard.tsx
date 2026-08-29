"use client";

import { useRef, useState } from "react";
import clsx from "clsx";

export default function UploadCard({
  label,
  description,
  badgeText,
  badgeIcon,
  mainIcon,
  theme = "primary",
  file,
  pageCount,
  onFile,
  onClear,
  disabled,
}: {
  label: string;
  description: string;
  badgeText: string;
  badgeIcon: string;
  mainIcon: string;
  theme?: "primary" | "secondary";
  file: File | null;
  pageCount?: number;
  onFile: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const themeClasses = {
    primary: {
      gradient: "from-primary-container/20 to-tertiary-fixed/30",
      borderHover: "hover:border-primary-container",
      shadowHover: "hover:shadow-primary-container/5",
      badgeIconText: "text-primary",
      iconBg: "bg-primary-container/10",
      iconHoverBg: "group-hover:bg-primary-container group-hover:text-on-primary-container",
      iconText: "text-primary group-hover:text-on-primary-container",
      buttonBg: "bg-primary text-on-primary",
      dragBorder: "border-primary-container bg-surface-container-high/50 scale-[1.02]",
    },
    secondary: {
      gradient: "from-secondary-container/20 to-tertiary-fixed/30",
      borderHover: "hover:border-secondary-container",
      shadowHover: "hover:shadow-secondary-container/5",
      badgeIconText: "text-secondary",
      iconBg: "bg-secondary-container/10",
      iconHoverBg: "group-hover:bg-secondary-container group-hover:text-on-secondary-container",
      iconText: "text-secondary group-hover:text-on-secondary-container",
      buttonBg: "bg-secondary text-on-secondary",
      dragBorder: "border-secondary-container bg-surface-container-high/50 scale-[1.02]",
    },
  }[theme];

  return (
    <div
      className={clsx("relative group cursor-pointer h-full w-full", disabled && "pointer-events-none opacity-50")}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <div
        className={clsx(
          "absolute -inset-1 rounded-3xl blur transition duration-500 bg-gradient-to-br",
          themeClasses.gradient,
          dragOver ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      />
      <div
        className={clsx(
          "relative bg-surface-container-lowest rounded-3xl p-8 h-full flex flex-col items-center justify-center border-2 border-dashed transition-all duration-300 shadow-sm hover:shadow-xl group-hover:-translate-y-1",
          dragOver ? themeClasses.dragBorder : `border-outline-variant/60 ${themeClasses.borderHover} ${themeClasses.shadowHover}`
        )}
      >
        <div className="absolute top-6 right-6 bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm">
          <span className={clsx("material-symbols-outlined text-[16px]", themeClasses.badgeIconText)}>{badgeIcon}</span>
          {badgeText}
        </div>

        {file ? (
          <div className="flex flex-col items-center justify-center gap-4 py-4 w-full">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-surface-container-high text-on-surface-variant">
              <span className="material-symbols-outlined text-[32px]">description</span>
            </div>
            <div className="text-center w-full max-w-[200px]">
              <p className="truncate font-headline-md text-headline-md text-on-surface" title={file.name}>
                {file.name}
              </p>
              <p className="font-label-sm text-label-sm text-on-surface-variant/70 mt-1">
                {(file.size / (1024 * 1024)).toFixed(1)}MB{pageCount ? ` · ${pageCount} pg` : ""}
              </p>
            </div>
            {!disabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                className="mt-2 text-error font-label-sm hover:underline"
              >
                Remove File
              </button>
            )}
          </div>
        ) : (
          <>
            <div
              className={clsx(
                "w-20 h-20 rounded-full flex items-center justify-center mb-6 transition-colors duration-300",
                themeClasses.iconBg,
                themeClasses.iconHoverBg
              )}
            >
              <span className={clsx("material-symbols-outlined text-[40px]", themeClasses.iconText)}>
                {mainIcon}
              </span>
            </div>
            <h3 className="font-headline-md text-headline-md text-on-surface mb-3 text-center">{label}</h3>
            <p className="font-body-md text-body-md text-on-surface-variant text-center mb-8">{description}</p>
            <button
              className={clsx(
                "font-label-md text-label-md px-6 py-3 rounded-full hover:scale-105 active:scale-95 transition-transform shadow-md",
                themeClasses.buttonBg
              )}
            >
              Browse Files
            </button>
            <div className="mt-4 font-label-sm text-label-sm text-on-surface-variant/70 uppercase tracking-widest">
              or drag & drop
            </div>
          </>
        )}
      </div>
    </div>
  );
}
