import { describe, expect, it } from "vitest";
import { buildRanks, combine, LABEL_EXACT, WEAK_SIGNAL } from "./stages";

describe("combine", () => {
  it("returns the flat exact-label score regardless of the other signals", () => {
    expect(combine(LABEL_EXACT, 0, 0)).toBe(0.97);
    expect(combine(LABEL_EXACT, 1, 1)).toBe(0.97);
  });

  it("boosts a strong semantic match with no positional evidence rather than diluting it", () => {
    // spatial <= WEAK_SIGNAL and semantic > WEAK_SIGNAL -> semantic * 0.85, not the
    // plain weighted average (which would cap out well below the review threshold).
    const combined = combine(0, 0, 0.9);
    expect(combined).toBeCloseTo(0.9 * 0.85, 4);
    expect(combined).toBeGreaterThan(0.45); // clears mapping_review_threshold
  });

  it("renormalises spatial+semantic and applies the unlabelled penalty otherwise", () => {
    const combined = combine(0, 0.5, 0.5);
    const expected = ((0.2 * 0.5 + 0.25 * 0.5) / (0.2 + 0.25)) * 0.85;
    expect(combined).toBeCloseTo(Math.round(expected * 10000) / 10000, 4);
  });

  it("caps the blended score at 0.99", () => {
    expect(combine(0.55, 1, 1)).toBeLessThanOrEqual(0.99);
  });

  it("treats WEAK_SIGNAL as the boundary between the two unlabelled branches", () => {
    // spatial just above WEAK_SIGNAL should NOT trigger the semantic*0.85 shortcut.
    const atBoundary = combine(0, WEAK_SIGNAL, 0.9);
    const justAbove = combine(0, WEAK_SIGNAL + 0.001, 0.9);
    expect(atBoundary).toBeCloseTo(0.9 * 0.85, 4); // spatial <= WEAK_SIGNAL still qualifies
    expect(justAbove).not.toBeCloseTo(0.9 * 0.85, 4);
  });
});

describe("buildRanks", () => {
  it("returns an empty map for no items", () => {
    expect(buildRanks([]).size).toBe(0);
  });

  it("centers a single item at 0.5", () => {
    expect(buildRanks(["a"]).get("a")).toBe(0.5);
  });

  it("spaces multiple items evenly across [0, 1]", () => {
    const ranks = buildRanks(["a", "b", "c"]);
    expect(ranks.get("a")).toBe(0);
    expect(ranks.get("b")).toBe(0.5);
    expect(ranks.get("c")).toBe(1);
  });
});
