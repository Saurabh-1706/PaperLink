"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import clsx from "clsx";

/**
 * Click-to-edit block for AI-generated text (transcription, feedback) that a
 * teacher should be able to correct. Read mode shows the text with a pencil
 * affordance; edit mode swaps in an auto-sized textarea. Enter (without
 * shift) or the check button saves; Escape or the X button cancels and
 * restores the previous value — nothing is saved on blur, so a stray click
 * elsewhere can't silently commit an accidental edit.
 */
export default function EditableText({
  value,
  onSave,
  placeholder,
  emptyLabel,
  className,
  textClassName,
  ariaLabel,
  readOnly,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  textClassName?: string;
  ariaLabel: string;
  /** Renders the text with no edit affordance — for roles that may read but not correct. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }
    }
  }, [editing]);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(value);
    setEditing(true);
  }

  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed !== value) onSave(trimmed);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (readOnly) {
    return (
      <div className={className}>
        {value ? (
          <p className={clsx("whitespace-pre-line leading-relaxed", textClassName)}>{value}</p>
        ) : (
          <p className="text-xs italic text-[#94A3B8]">{emptyLabel ?? "Nothing recorded"}</p>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div className={className} onClick={(e) => e.stopPropagation()}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            // Stop every key here — this sits inside a row that treats Enter/Space
            // as "select this question", which would otherwise hijack typing.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          rows={2}
          className="w-full resize-none rounded-lg border border-outline-variant/50 bg-surface-container-lowest p-2 text-xs leading-relaxed text-on-surface outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40"
        />
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button
            onClick={cancel}
            aria-label="Cancel edit"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-container text-on-surface-variant transition-[background-color,transform] duration-150 ease-out hover:bg-surface-container-high active:scale-90"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
          <button
            onClick={commit}
            aria-label="Save edit"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-on-primary transition-transform duration-150 ease-out active:scale-90"
          >
            <span className="material-symbols-outlined text-[16px]">check</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx(className, "group/edit relative")}>
      <button
        onClick={startEdit}
        aria-label={`Edit ${ariaLabel}`}
        className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-surface-container-lowest text-on-surface-variant opacity-0 shadow-sm transition-all duration-150 ease-out hover:text-primary hover:bg-primary-container/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-90 group-hover/edit:opacity-100"
      >
        <span className="material-symbols-outlined text-[16px]">edit</span>
      </button>
      {value ? (
        <p className={clsx("whitespace-pre-line leading-relaxed", textClassName)}>{value}</p>
      ) : (
        <button onClick={startEdit} className="text-left text-xs italic text-[#94A3B8] hover:text-[#FF5623]">
          {emptyLabel ?? "Click to add…"}
        </button>
      )}
    </div>
  );
}
