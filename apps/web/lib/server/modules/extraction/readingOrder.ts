/**
 * Reading order: column detection first, then top-to-bottom, left-to-right.
 * Port of backend/app/modules/extraction/reading_order.py.
 *
 * A naive pure-y sort interleaves the columns of a two-column paper and silently
 * destroys question boundaries.
 */
import type { BBox } from "./geometry";

const MIN_COLUMN_GAP = 0.06;
const MIN_BLOCKS_FOR_COLUMNS = 6;

type ColumnRange = [number, number];

/** Returns column x-ranges. A single range means the page is single-column. */
export function detectColumns(boxes: BBox[]): ColumnRange[] {
  if (boxes.length < MIN_BLOCKS_FOR_COLUMNS) return [[0, 1]];

  const spans = boxes.map((b): ColumnRange => [b.x1, b.x2]).sort((a, b) => a[0] - b[0]);
  const merged: ColumnRange[] = [];
  for (const [x1, x2] of spans) {
    const last = merged[merged.length - 1];
    if (last && x1 <= last[1] + MIN_COLUMN_GAP) {
      last[1] = Math.max(last[1], x2);
    } else {
      merged.push([x1, x2]);
    }
  }
  if (merged.length < 2) return [[0, 1]];

  const counts = merged.map((_, i) => boxes.filter((b) => columnIndex(b, merged) === i).length);
  if (Math.min(...counts) < Math.max(2, Math.floor(boxes.length / 10))) return [[0, 1]];
  return merged;
}

function columnIndex(box: BBox, columns: ColumnRange[]): number {
  const centre = (box.x1 + box.x2) / 2;
  let best = 0;
  let bestDistance = Infinity;
  columns.forEach(([x1, x2], index) => {
    if (x1 <= centre && centre <= x2) {
      best = index;
      bestDistance = -1;
      return;
    }
    if (bestDistance < 0) return;
    const distance = Math.min(Math.abs(centre - x1), Math.abs(centre - x2));
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Returns indices of `boxes` in reading order. */
export function orderBoxes(boxes: BBox[]): number[] {
  if (boxes.length === 0) return [];
  const columns = detectColumns(boxes);
  const keyed = boxes.map(
    (box, index) => [columnIndex(box, columns), Math.round(box.y1 * 1000) / 1000, box.x1, index] as const
  );
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return keyed.map((entry) => entry[3]);
}
