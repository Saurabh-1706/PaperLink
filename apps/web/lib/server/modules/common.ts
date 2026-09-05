/**
 * Shared cross-module schema pieces. Port of backend/app/schemas/common.py's
 * `Region`/`union_all` and the pipeline-wide string-union types. `BBox` itself
 * already lives in `extraction/geometry.ts` — the one place bbox math happens,
 * per CLAUDE.md — this only adds the page-anchored wrapper around it.
 */
import type { BBox } from "./extraction/geometry";
import { validateBbox } from "./extraction/geometry";

/** A page-anchored box. Regions are always a list, even when there is one. */
export interface Region {
  page: number; // 1-based
  bbox: BBox;
}

function unionBBox(a: BBox, b: BBox): BBox {
  return validateBbox({
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  });
}

export function unionAll(boxes: BBox[]): BBox {
  if (boxes.length === 0) throw new Error("unionAll requires at least one box");
  return boxes.reduce(unionBBox);
}

export type MappingType = "direct" | "semantic" | "spatial" | "unmatched" | "unanswered";
export type ReviewStatus = "auto_accepted" | "needs_review" | "human_confirmed" | "human_corrected";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type JobStage =
  | "ingestion"
  | "extraction"
  | "question_extraction"
  | "answer_extraction"
  | "mapping"
  | "grading"
  | "done";
