"use client";

import type { PageImage } from "./types";

/**
 * Vision LLMs (GPT-4o, Claude, etc.) have no native pixel-grounding — asked to
 * estimate a bounding box "by eye" on a raw image, they guess, and the guess
 * is often way off. The standard mitigation is to give the model something
 * concrete to read coordinates off of: burn a labeled percentage grid into
 * the image before sending it, and have the model report gridline-relative
 * positions instead of freehand fractions. This measurably improves spatial
 * accuracy for models without a trained detection head (unlike e.g. Gemini's
 * native box_2d grounding, which doesn't need this crutch).
 *
 * Only used for the copy of the page sent to the answer-extraction call —
 * the clean, ungridded page is what's actually displayed to the teacher.
 */
export async function addCoordinateGrid(page: PageImage, step = 10): Promise<PageImage> {
  const img = new Image();
  img.src = page.dataUrl;
  if (img.decode) {
    await img.decode();
  } else {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, page.width, page.height);

  ctx.save();
  ctx.strokeStyle = "rgba(255, 0, 128, 0.35)";
  ctx.fillStyle = "rgba(255, 0, 128, 0.85)";
  ctx.lineWidth = 1;
  ctx.font = `${Math.max(10, Math.round(page.width * 0.011))}px sans-serif`;

  for (let pct = 0; pct <= 100; pct += step) {
    const x = (pct / 100) * page.width;
    const y = (pct / 100) * page.height;

    // Vertical gridline + top-edge label (x position)
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, page.height);
    ctx.stroke();
    ctx.fillText(`x${pct}`, Math.min(x + 2, page.width - 24), 12);

    // Horizontal gridline + left-edge label (y position)
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(page.width, y);
    ctx.stroke();
    ctx.fillText(`y${pct}`, 2, Math.max(y - 2, 12));
  }
  ctx.restore();

  // JPEG, not PNG — this copy is only ever sent to the model (never displayed),
  // and PNG's lossless encoding is needless payload weight on top of pages
  // that are already capped in lib/pdf.ts.
  return { ...page, dataUrl: canvas.toDataURL("image/jpeg", 0.85) };
}
