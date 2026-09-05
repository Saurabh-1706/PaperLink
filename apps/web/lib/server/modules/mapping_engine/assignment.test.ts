import { describe, expect, it } from "vitest";
import { solve } from "./assignment";

function totalScore(matrix: number[][], pairs: Array<[number, number]>): number {
  return pairs.reduce((sum, [r, c]) => sum + matrix[r][c], 0);
}

describe("solve (Hungarian assignment)", () => {
  it("returns nothing for an empty matrix", () => {
    expect(solve([], 0)).toEqual([]);
    expect(solve([[]], 0)).toEqual([]);
  });

  it("solves a trivial 1x1 case", () => {
    expect(solve([[0.9]], 0)).toEqual([[0, 0]]);
  });

  it("maximises total score, not the greedy per-row best", () => {
    // Row 0's best is column 0 (0.9), but taking it forces row 1 into column 1 (0.1),
    // for a total of 1.0. Swapping — row0->col1 (0.85), row1->col0 (0.8) — totals 1.65.
    // The optimal assignment must find the swap; a greedy per-row pick would not.
    const matrix = [
      [0.9, 0.85],
      [0.8, 0.1],
    ];
    const pairs = solve(matrix, 0);
    expect(new Set(pairs.map(([r]) => r))).toEqual(new Set([0, 1]));
    expect(new Set(pairs.map(([, c]) => c))).toEqual(new Set([0, 1]));
    expect(totalScore(matrix, pairs)).toBeCloseTo(1.65, 6);
  });

  it("drops pairs below the reject floor even when they were part of the optimal solve", () => {
    const matrix = [[0.9, 0.1]];
    const pairs = solve(matrix, 0.5);
    // Optimal is row0->col0 (0.9), which clears the floor; col1 alone would not.
    expect(pairs).toEqual([[0, 0]]);
  });

  it("handles more questions than answers (rows > cols)", () => {
    const matrix = [
      [0.9, 0.2],
      [0.1, 0.8],
      [0.3, 0.3],
    ];
    const pairs = solve(matrix, 0);
    // Only 2 answers exist, so at most 2 pairs; rows must be distinct and columns
    // must be distinct.
    expect(pairs.length).toBe(2);
    const rows = pairs.map(([r]) => r);
    const cols = pairs.map(([, c]) => c);
    expect(new Set(rows).size).toBe(rows.length);
    expect(new Set(cols).size).toBe(cols.length);
    // The optimal total here is row0->col0 (0.9) + row1->col1 (0.8) = 1.7.
    expect(totalScore(matrix, pairs)).toBeCloseTo(1.7, 6);
  });

  it("handles more answers than questions (cols > rows)", () => {
    const matrix = [[0.2, 0.9, 0.4]];
    const pairs = solve(matrix, 0);
    expect(pairs).toEqual([[0, 1]]);
  });

  it("never reuses a row or column across pairs", () => {
    const matrix = [
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
    ];
    const pairs = solve(matrix, 0);
    const rows = pairs.map(([r]) => r);
    const cols = pairs.map(([, c]) => c);
    expect(new Set(rows).size).toBe(3);
    expect(new Set(cols).size).toBe(3);
  });
});
