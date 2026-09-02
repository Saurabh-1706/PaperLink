/**
 * The ONLY place that converts coordinates. Port of backend/app/modules/extraction/ir.py.
 * docs/03-coordinate-contract.md: bbox = [x1,y1,x2,y2], normalised floats in [0,1],
 * origin top-left, relative to the page's ORIGINAL dimensions.
 *
 * `Transform`/`TransformChain` exist for preprocessing steps that move pixels before
 * OCR sees them (deskew, rectify) — Phase 1 defers those (see extraction/pipeline.ts),
 * so every chain built today has zero recorded steps and composes to the identity.
 * They are ported now, not added later, because docs/03-coordinate-contract.md treats
 * "the composed transform must be inverted before storing anything" as a binding
 * invariant of this module, not an optional feature.
 */

export const MIN_REGION_AREA = 1e-6;

export interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function bboxArea(box: BBox): number {
  return (box.x2 - box.x1) * (box.y2 - box.y1);
}

/** Degenerate boxes are a validation failure, not a stored value. */
export function validateBbox(box: BBox): BBox {
  for (const [key, value] of Object.entries(box)) {
    if (value < 0 || value > 1) throw new Error(`bbox.${key} out of [0,1]: ${value}`);
  }
  if (!(box.x1 < box.x2 && box.y1 < box.y2)) {
    throw new Error(`degenerate bbox: [${box.x1},${box.y1},${box.x2},${box.y2}]`);
  }
  if (bboxArea(box) < MIN_REGION_AREA) {
    throw new Error(`bbox area below minimum threshold: [${box.x1},${box.y1},${box.x2},${box.y2}]`);
  }
  return box;
}

export function bboxToList(box: BBox): number[] {
  return [box.x1, box.y1, box.x2, box.y2];
}

type Point = [number, number];

/** Affine map from ORIGINAL page pixel space to PREPROCESSED image pixel space.
 * x' = a*x + b*y + c ; y' = d*x + e*y + f */
export class Transform {
  constructor(
    readonly a = 1,
    readonly b = 0,
    readonly c = 0,
    readonly d = 0,
    readonly e = 1,
    readonly f = 0
  ) {}

  static identity(): Transform {
    return new Transform();
  }

  static scaling(sx: number, sy: number): Transform {
    if (sx <= 0 || sy <= 0) throw new Error("scale factors must be positive");
    return new Transform(sx, 0, 0, 0, sy, 0);
  }

  static translation(tx: number, ty: number): Transform {
    return new Transform(1, 0, tx, 0, 1, ty);
  }

  /** Self followed by `other` (i.e. other ∘ self). */
  then(other: Transform): Transform {
    return new Transform(
      other.a * this.a + other.b * this.d,
      other.a * this.b + other.b * this.e,
      other.a * this.c + other.b * this.f + other.c,
      other.d * this.a + other.e * this.d,
      other.d * this.b + other.e * this.e,
      other.d * this.c + other.e * this.f + other.f
    );
  }

  apply([x, y]: Point): Point {
    return [this.a * x + this.b * y + this.c, this.d * x + this.e * y + this.f];
  }

  invert(): Transform {
    const det = this.a * this.e - this.b * this.d;
    if (Math.abs(det) < 1e-12) throw new Error("transform is not invertible");
    const ia = this.e / det;
    const ib = -this.b / det;
    const id_ = -this.d / det;
    const ie = this.a / det;
    return new Transform(ia, ib, -(ia * this.c + ib * this.f), id_, ie, -(id_ * this.c + ie * this.f));
  }
}

/** Records each preprocessing step so the composed transform can be inverted. */
export class TransformChain {
  private steps: Transform[] = [];

  record(transform: Transform): void {
    this.steps.push(transform);
  }

  composed(): Transform {
    return this.steps.reduce((acc, step) => acc.then(step), Transform.identity());
  }

  /** Maps a box from preprocessed-image space back to original page pixel space. */
  toOriginal(boxPx: [number, number, number, number]): [number, number, number, number] {
    const inverse = this.composed().invert();
    const [x1, y1, x2, y2] = boxPx;
    const corners: Point[] = [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
    ].map((p) => inverse.apply(p as Point));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Original page pixel/point space -> normalised [0,1] page space. */
export function normalizeBbox(
  boxPx: [number, number, number, number],
  pageWidth: number,
  pageHeight: number
): BBox {
  if (pageWidth <= 0 || pageHeight <= 0) throw new Error("page dimensions must be positive");
  const [bx1, by1, bx2, by2] = boxPx;
  const [x1, x2] = [Math.min(bx1, bx2), Math.max(bx1, bx2)];
  const [y1, y2] = [Math.min(by1, by2), Math.max(by1, by2)];
  return validateBbox({
    x1: clamp(x1 / pageWidth),
    y1: clamp(y1 / pageHeight),
    x2: clamp(x2 / pageWidth),
    y2: clamp(y2 / pageHeight),
  });
}

/** Normalise, returning null instead of throwing for degenerate/noise boxes. */
export function safeNormalizeBbox(
  boxPx: [number, number, number, number],
  pageWidth: number,
  pageHeight: number
): BBox | null {
  try {
    return normalizeBbox(boxPx, pageWidth, pageHeight);
  } catch {
    return null;
  }
}

/** A fractional [0,1] box already relative to a uniform render of the page (e.g. what
 * Gemini OCR returns) needs validation only, not a pixel-space scale conversion. */
export function safeValidateFractionalBbox(box: [number, number, number, number]): BBox | null {
  const [bx1, by1, bx2, by2] = box;
  const [x1, x2] = [Math.min(bx1, bx2), Math.max(bx1, bx2)];
  const [y1, y2] = [Math.min(by1, by2), Math.max(by1, by2)];
  try {
    return validateBbox({ x1: clamp(x1), y1: clamp(y1), x2: clamp(x2), y2: clamp(y2) });
  } catch {
    return null;
  }
}

export function denormalizeBbox(
  box: BBox,
  pageWidth: number,
  pageHeight: number
): [number, number, number, number] {
  return [box.x1 * pageWidth, box.y1 * pageHeight, box.x2 * pageWidth, box.y2 * pageHeight];
}
