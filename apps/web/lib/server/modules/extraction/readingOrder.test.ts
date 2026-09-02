import { describe, expect, it } from "vitest";
import { detectColumns, orderBoxes } from "./readingOrder";
import type { BBox } from "./geometry";

function box(x1: number, y1: number, x2: number, y2: number): BBox {
  return { x1, y1, x2, y2 };
}

describe("detectColumns", () => {
  it("treats a page with few blocks as single-column", () => {
    const boxes = [box(0, 0, 0.4, 0.1), box(0.6, 0, 1, 0.1)];
    expect(detectColumns(boxes)).toEqual([[0, 1]]);
  });

  it("splits a genuine two-column layout", () => {
    const left = Array.from({ length: 6 }, (_, i) => box(0.05, i * 0.1, 0.4, i * 0.1 + 0.08));
    const right = Array.from({ length: 6 }, (_, i) => box(0.55, i * 0.1, 0.95, i * 0.1 + 0.08));
    const columns = detectColumns([...left, ...right]);
    expect(columns.length).toBe(2);
  });
});

describe("orderBoxes", () => {
  it("orders single-column blocks top-to-bottom", () => {
    const boxes = [box(0, 0.5, 1, 0.6), box(0, 0.1, 1, 0.2), box(0, 0.3, 1, 0.4)];
    expect(orderBoxes(boxes)).toEqual([1, 2, 0]);
  });

  it("does not interleave two columns (column-major, not a naive y-sort)", () => {
    const left = Array.from({ length: 6 }, (_, i) => box(0.05, i * 0.1, 0.4, i * 0.1 + 0.08));
    const right = Array.from({ length: 6 }, (_, i) => box(0.55, i * 0.1, 0.95, i * 0.1 + 0.08));
    const boxes = [...left, ...right];
    const order = orderBoxes(boxes);
    // All left-column indices (0-5) must precede all right-column indices (6-11).
    const firstRightPosition = order.findIndex((i) => i >= 6);
    expect(Math.max(...order.slice(0, firstRightPosition))).toBeLessThan(6);
  });

  it("returns an empty order for no boxes", () => {
    expect(orderBoxes([])).toEqual([]);
  });
});
