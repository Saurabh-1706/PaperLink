"use client";

import type { PageImage } from "./types";

let workerConfigured = false;

async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    // Served from /public — copied there at build/dev time (see scripts/copy-pdf-worker.js
    // note in README). Falls back to the CDN if the local copy is missing.
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerConfigured = true;
  }
  return pdfjs;
}

// Vision models (Claude, GPT-4o, Gemini) internally downscale any image
// beyond roughly this size before looking at it — sending anything larger
// only inflates upload time and request payload without adding legibility.
// Capping here also keeps large scanned PDFs/phone photos from ballooning
// the answer-extraction request, which is the main source of slow mapping
// on big documents.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

/**
 * Downscales a canvas to fit within MAX_DIMENSION on its long edge (leaves it
 * alone if already smaller) and encodes it as JPEG rather than PNG — for
 * photographed/scanned pages JPEG is dramatically smaller than lossless PNG
 * at a quality loss that doesn't matter for OCR. Returns the final pixel
 * dimensions alongside the data URL since callers need them to stay in sync
 * (e.g. the coordinate grid drawn on top later, and on-screen highlighting,
 * both size themselves off PageImage.width/height).
 */
function canvasToCappedImage(source: HTMLCanvasElement): { dataUrl: string; width: number; height: number } {
  const longEdge = Math.max(source.width, source.height);
  if (longEdge <= MAX_DIMENSION) {
    return { dataUrl: source.toDataURL("image/jpeg", JPEG_QUALITY), width: source.width, height: source.height };
  }
  const ratio = MAX_DIMENSION / longEdge;
  const width = Math.round(source.width * ratio);
  const height = Math.round(source.height * ratio);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d")!.drawImage(source, 0, 0, width, height);
  return { dataUrl: out.toDataURL("image/jpeg", JPEG_QUALITY), width, height };
}

/** Renders every page of a File (PDF or a single image) to capped-size JPEG data URLs. */
export async function fileToPageImages(file: File): Promise<PageImage[]> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return renderPdfPages(file);
  }
  if (file.type.startsWith("image/")) {
    return [await imageFileToPageImage(file)];
  }
  throw new Error(`Unsupported file type: ${file.type || file.name}`);
}

async function imageFileToPageImage(file: File): Promise<PageImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = new Image();
  img.src = dataUrl;
  if (img.decode) {
    await img.decode();
  } else {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
  }

  // Draw through a canvas (rather than using the raw file dataUrl directly) so
  // large phone-camera photos get the same size cap and JPEG re-encode as PDF
  // pages — an uploaded 4000x3000 photo would otherwise be the single biggest
  // payload in the whole request.
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  const capped = canvasToCappedImage(canvas);
  return { pageIndex: 0, dataUrl: capped.dataUrl, width: capped.width, height: capped.height };
}

async function renderPdfPages(file: File): Promise<PageImage[]> {
  const pdfjs = await getPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  // Render pages concurrently instead of one at a time — each page gets its
  // own canvas, so there's no shared-state hazard, and this cuts client-side
  // rendering time roughly proportional to page count on multi-page PDFs.
  const pageNumbers = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const pages = await Promise.all(
    pageNumbers.map(async (i) => {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 }); // upscale for OCR legibility
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const capped = canvasToCappedImage(canvas);
      return {
        pageIndex: i - 1,
        dataUrl: capped.dataUrl,
        width: capped.width,
        height: capped.height,
      };
    })
  );

  return pages;
}
