import { describe, expect, it } from "vitest";
import {
  Transform,
  TransformChain,
  denormalizeBbox,
  normalizeBbox,
  safeNormalizeBbox,
  safeValidateFractionalBbox,
  validateBbox,
} from "./geometry";

describe("normalizeBbox", () => {
  it("normalises pixel space against page dimensions", () => {
    const bbox = normalizeBbox([100, 200, 300, 400], 1000, 800);
    expect(bbox).toEqual({ x1: 0.1, y1: 0.25, x2: 0.3, y2: 0.5 });
  });

  it("sorts inverted corners", () => {
    const bbox = normalizeBbox([300, 400, 100, 200], 1000, 800);
    expect(bbox).toEqual({ x1: 0.1, y1: 0.25, x2: 0.3, y2: 0.5 });
  });

  it("round-trips through denormalizeBbox", () => {
    const bbox = normalizeBbox([100, 200, 300, 400], 1000, 800);
    expect(denormalizeBbox(bbox, 1000, 800)).toEqual([100, 200, 300, 400]);
  });

  it("throws on non-positive page dimensions", () => {
    expect(() => normalizeBbox([0, 0, 10, 10], 0, 100)).toThrow();
  });
});

describe("validateBbox", () => {
  it("rejects a degenerate box", () => {
    expect(() => validateBbox({ x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.9 })).toThrow(/degenerate/);
  });

  it("rejects a box below the minimum area", () => {
    expect(() => validateBbox({ x1: 0.1, y1: 0.1, x2: 0.1000001, y2: 0.1000001 })).toThrow(/area/);
  });

  it("accepts a valid box", () => {
    expect(validateBbox({ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 })).toEqual({ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 });
  });
});

describe("safeNormalizeBbox / safeValidateFractionalBbox", () => {
  it("returns null instead of throwing for a degenerate box", () => {
    expect(safeNormalizeBbox([100, 100, 100, 100], 1000, 1000)).toBeNull();
    expect(safeValidateFractionalBbox([0.5, 0.5, 0.5, 0.9])).toBeNull();
  });

  it("validates an already-fractional box unchanged", () => {
    expect(safeValidateFractionalBbox([0.1, 0.2, 0.3, 0.4])).toEqual({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 });
  });
});

describe("Transform / TransformChain", () => {
  it("identity composes to a no-op", () => {
    const chain = new TransformChain();
    chain.record(Transform.identity());
    expect(chain.toOriginal([10, 20, 30, 40])).toEqual([10, 20, 30, 40]);
  });

  it("inverts a scale+translate chain back to the original box", () => {
    const chain = new TransformChain();
    chain.record(Transform.scaling(2, 2));
    chain.record(Transform.translation(5, 5));
    // A box at (10,20)-(30,40) in original space maps to (25,45)-(65,85) after
    // scale-then-translate; toOriginal should invert that exactly.
    const forward = Transform.scaling(2, 2).then(Transform.translation(5, 5));
    const [fx1, fy1] = forward.apply([10, 20]);
    const [fx2, fy2] = forward.apply([30, 40]);
    expect(chain.toOriginal([fx1, fy1, fx2, fy2])).toEqual([10, 20, 30, 40]);
  });
});
