/**
 * PDF access: per-page classification, rendering, and native word extraction.
 * Port of backend/app/modules/documents/pdf.py, replacing PyMuPDF with
 * `pdfjs-dist` (pure JS/WASM) + `@napi-rs/canvas` (prebuilt native binaries, safe on
 * Vercel's Node serverless runtime — unlike `canvas`/`node-canvas`, which needs a
 * native compile step Vercel's build image does not reliably provide).
 *
 * This module never converts coordinates — it reports raw geometry plus page
 * dimensions, and extraction/geometry.ts normalises. Perspective-rectification of
 * photographed pages (rectify.py) is deferred out of Phase 1 (see the migration
 * plan): Gemini vision tolerates skew/lighting far better than a local OCR engine
 * did, so the value of that step is much lower now than it was.
 */
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument as PdfLibDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";

/** pdfjs-dist's `TextItem` type isn't re-exported from the package root (only from an
 * internal path), so this mirrors the handful of fields actually used here. */
interface TextItem {
  str: string;
  transform: number[];
  width: number;
  hasEOL: boolean;
}
import { settings } from "@/lib/server/config";
import { CorruptDocumentError, EncryptedPdfError, TooManyPagesError } from "@/lib/server/errors";
import type { PageClassification } from "@/lib/server/modules/extraction/types";

// pdfjs-dist's legacy build (ESM, since v4 dropped the CJS build) works without a
// browser DOM as long as it is given a canvas factory; there's no worker here since
// we call it directly, in-process, one Vercel function invocation at a time.

export interface NativeWord {
  text: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineIndex: number;
}

export interface PageRender {
  pageNumber: number;
  width: number; // original page width, in PDF points (scale=1 viewport)
  height: number; // original page height, in PDF points
  dpi: number;
  imageBytes: Buffer;
  imageWidth: number;
  imageHeight: number;
  classification: PageClassification;
  nativeWords: NativeWord[];
}

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext: { canvas: unknown }, width: number, height: number) {
    const canvas = canvasAndContext.canvas as ReturnType<typeof createCanvas>;
    canvas.width = width;
    canvas.height = height;
  }
  destroy(_canvasAndContext: unknown) {
    // no-op: GC handles it
  }
}

async function openDocument(data: Buffer) {
  // `canvasFactory` is a real, documented pdfjs-dist runtime option (its own Node.js
  // examples pass it) that the published v4 types don't declare — hence the cast.
  const params = {
    data: new Uint8Array(data),
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
    useSystemFonts: true,
  } as unknown as Parameters<typeof pdfjsLib.getDocument>[0];
  const loadingTask = pdfjsLib.getDocument(params);
  try {
    return await loadingTask.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException") throw new EncryptedPdfError();
    throw new CorruptDocumentError(String((err as Error)?.message ?? err));
  }
}

/** Opens just far enough to report page count / encryption, for upload validation. */
export async function inspectPdf(data: Buffer): Promise<{ pageCount: number }> {
  const doc = await openDocument(data);
  try {
    const pageCount = doc.numPages;
    if (pageCount === 0) throw new CorruptDocumentError("The PDF contains no pages.");
    if (pageCount > settings.maxPages) {
      throw new TooManyPagesError(`The document exceeds the page cap.`, {
        pageCount,
        cap: settings.maxPages,
      });
    }
    return { pageCount };
  } finally {
    await doc.destroy();
  }
}

/** Wraps one or more raw JPEG/PNG images into a single PDF, one page per image, each
 * page sized to that image's own pixel dimensions — lets a photographed sheet enter
 * the same downstream pipeline as a real PDF. */
export async function imagesToPdf(images: Buffer[]): Promise<Buffer> {
  const doc = await PdfLibDocument.create();
  for (const bytes of images) {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return Buffer.from(await doc.save());
}

const SEARCHABLE_COVERAGE = () => settings.searchableCoverageThreshold;

/** Item transform -> viewport-space rect. pdf.js gives glyph transforms in PDF user
 * space; `Util.transform(viewport.transform, item.transform)` composes them into the
 * same top-left-origin, y-down frame as the rendered raster (this is the same
 * technique pdf.js's own text-layer builder uses). Ascent/descent are approximated as
 * fixed fractions of the font-transform height, since exact font metrics aren't
 * available here — fine for a line-grouping/highlight box, not meant to be
 * typographically exact. */
function itemRect(item: TextItem, viewport: PageViewport) {
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const widthScale = Math.hypot(tx[0], tx[1]) || 1;
  const width = item.width * widthScale;
  const x = tx[4];
  const yBaseline = tx[5];
  const y1 = yBaseline - fontHeight * 0.8;
  const y2 = yBaseline + fontHeight * 0.25;
  return { x1: x, y1, x2: x + width, y2 };
}

async function extractNativeWords(page: PDFPageProxy, viewport: PageViewport): Promise<NativeWord[]> {
  const content = await page.getTextContent();
  const words: NativeWord[] = [];
  let lineIndex = 0;
  for (const item of content.items) {
    if (!("str" in item)) continue; // skip TextMarkedContent entries
    const text = item.str;
    if (text && text.trim()) {
      const rect = itemRect(item, viewport);
      words.push({ text, ...rect, lineIndex });
    }
    if (item.hasEOL) lineIndex += 1;
  }
  return words;
}

/** Text coverage ratio decides the extraction path (ADR-005). */
async function classifyPage(page: PDFPageProxy, viewport: PageViewport): Promise<PageClassification> {
  const pageArea = viewport.width * viewport.height;
  if (pageArea <= 0) return "scanned";
  const words = await extractNativeWords(page, viewport);
  if (words.length === 0) return "scanned";
  const textArea = words.reduce(
    (sum, w) => sum + Math.max(0, w.x2 - w.x1) * Math.max(0, w.y2 - w.y1),
    0
  );
  return textArea / pageArea > SEARCHABLE_COVERAGE() ? "searchable" : "scanned";
}

export async function renderPages(data: Buffer, dpi?: number): Promise<PageRender[]> {
  const targetDpi = dpi ?? settings.renderDpi;
  const doc = await openDocument(data);
  const renders: PageRender[] = [];
  try {
    for (let index = 0; index < doc.numPages; index++) {
      const page: PDFPageProxy = await doc.getPage(index + 1);
      const baseViewport = page.getViewport({ scale: 1 });
      const classification = await classifyPage(page, baseViewport);
      const nativeWords = await extractNativeWords(page, baseViewport);

      let zoom = targetDpi / 72;
      const longEdgePx = Math.max(baseViewport.width, baseViewport.height) * zoom;
      if (longEdgePx > settings.renderMaxLongEdge) {
        zoom *= settings.renderMaxLongEdge / longEdgePx;
      }
      const viewport = page.getViewport({ scale: zoom });
      const canvasFactory = new NodeCanvasFactory();
      const { canvas, context } = canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      // @napi-rs/canvas's context is API-compatible with the DOM CanvasRenderingContext2D
      // pdf.js's browser-oriented types expect; the cast bridges the two type identities.
      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      const imageBytes = canvas.toBuffer("image/png");

      renders.push({
        pageNumber: index + 1,
        width: baseViewport.width,
        height: baseViewport.height,
        dpi: Math.round(72 * zoom),
        imageBytes,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        classification,
        nativeWords,
      });
    }
  } finally {
    await doc.destroy();
  }
  return renders;
}

/** Groups native words into lines, by the line index pdf.js's own text stream
 * already assigns via `hasEOL` — the flattened equivalent of PyMuPDF's
 * (block_no, line_no) grouping, since pdf.js doesn't expose block structure
 * directly. */
export function groupWordsIntoLines(words: NativeWord[]): Array<[string, [number, number, number, number]]> {
  const buckets = new Map<number, NativeWord[]>();
  for (const word of words) {
    const bucket = buckets.get(word.lineIndex) ?? [];
    bucket.push(word);
    buckets.set(word.lineIndex, bucket);
  }
  const lines: Array<[string, [number, number, number, number]]> = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = [...buckets.get(key)!].sort((a, b) => a.x1 - b.x1);
    const text = group
      .map((w) => w.text)
      .join(" ")
      .trim();
    if (!text) continue;
    const box: [number, number, number, number] = [
      Math.min(...group.map((w) => w.x1)),
      Math.min(...group.map((w) => w.y1)),
      Math.max(...group.map((w) => w.x2)),
      Math.max(...group.map((w) => w.y2)),
    ];
    lines.push([text, box]);
  }
  return lines;
}
