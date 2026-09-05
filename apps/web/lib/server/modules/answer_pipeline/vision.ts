/**
 * Stage 4 — vision-LLM transcription correction, one call per page. Port of
 * backend/app/modules/answer_pipeline/vision.py.
 *
 * The model sees the full page image and all OCR lines at once, which gives it the
 * context needed to read handwriting correctly. Coordinates are never touched
 * (ADR-001).
 *
 * Uses `@napi-rs/canvas` (already a dependency for PDF page rendering) instead of
 * Python's PIL for the crop/compress steps, and `Promise.all` instead of a
 * `ThreadPoolExecutor` — Node's I/O is already async, and `ai/rateLimit.ts` paces
 * the underlying model calls regardless of how many pages run concurrently.
 */
import { createHash } from "crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { settings } from "@/lib/server/config";
import { denormalizeBbox } from "../extraction/geometry";
import type { Region } from "../common";
import { cleanArtifacts, maskDomainTerms, restoreDomainTerms } from "@/lib/server/ai/correction";
import { transcribeCrop, transcribePage } from "@/lib/server/ai/transcriptionCorrection";
import { normalizeText, parseAnswerLabel } from "./pipeline";
import type { ExtractedAnswer } from "./types";

export const CONFIDENCE_AFTER_VALIDATION = 0.9;
const JPEG_QUALITY = 75; // good balance of size vs. readability for vision models

// Process-local memo for `compressForVision`. A page image does not change within a
// run, but every flagged answer group on that page asks for the same JPEG, so the
// decode/re-encode was being repeated for identical bytes. Bounded and evicted
// oldest-first so a long-lived process cannot grow it without limit.
const COMPRESS_CACHE_MAX = 8;
const compressCache = new Map<string, Buffer>();

function base64Length(bytes: Buffer): number {
  return bytes.toString("base64").length;
}

export async function cropRegion(imageBytes: Buffer, region: Region, padding = 0.01): Promise<Buffer> {
  const image = await loadImage(imageBytes);
  const [x1, y1, x2, y2] = denormalizeBbox(region.bbox, image.width, image.height);
  const padX = padding * image.width;
  const padY = padding * image.height;
  const bx1 = Math.max(0, Math.floor(x1 - padX));
  const by1 = Math.max(0, Math.floor(y1 - padY));
  const bx2 = Math.min(image.width, Math.floor(x2 + padX));
  const by2 = Math.min(image.height, Math.floor(y2 + padY));
  const w = Math.max(1, bx2 - bx1);
  const h = Math.max(1, by2 - by1);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, bx1, by1, w, h, 0, 0, w, h);
  return canvas.toBuffer("image/png");
}

/** Return JPEG-compressed bytes if the PNG exceeds `limit` encoded (base64) bytes. */
async function compressForVision(imageBytes: Buffer, limit: number): Promise<Buffer> {
  if (base64Length(imageBytes) <= limit) return imageBytes;

  const key = `${createHash("sha256").update(imageBytes).digest("hex")}:${limit}`;
  const cached = compressCache.get(key);
  if (cached !== undefined) return cached;

  const image = await loadImage(imageBytes);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const compressed = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
  // Still too large after compression — caller will skip vision for this page.
  const result = base64Length(compressed) <= limit ? compressed : imageBytes;

  if (compressCache.size >= COMPRESS_CACHE_MAX) {
    const oldest = compressCache.keys().next().value;
    if (oldest !== undefined) compressCache.delete(oldest);
  }
  compressCache.set(key, result);
  return result;
}

async function processPage(
  page: number,
  pageAnswers: ExtractedAnswer[],
  image: Buffer
): Promise<Map<string, string>> {
  const pageResult = new Map<string, string>();
  const compressed = await compressForVision(image, settings.maxInlineImageBytes);
  const cleanedLines = pageAnswers.map((a) => cleanArtifacts(a.rawText));
  const confidences = pageAnswers.map((a) => a.confidence);
  const maskedLines: string[] = [];
  const restoreMaps: Array<Record<string, string>> = [];
  for (const line of cleanedLines) {
    const [masked, restoreMap] = maskDomainTerms(line);
    maskedLines.push(masked);
    restoreMaps.push(restoreMap);
  }

  let result: string[] | null = null;
  try {
    result = await transcribePage(compressed, maskedLines, confidences);
  } catch {
    result = null;
  }

  if (result !== null) {
    pageAnswers.forEach((answer, i) => {
      const corrected = result![i];
      if (corrected && corrected.trim()) {
        const restored = restoreDomainTerms(corrected, restoreMaps[i]);
        pageResult.set(answer.answerId, normalizeText(restored));
      }
    });
  } else {
    for (let i = 0; i < pageAnswers.length; i++) {
      const answer = pageAnswers[i];
      const cleaned = cleanedLines[i];
      const restoreMap = restoreMaps[i];
      if (answer.regions.length === 0) continue;
      let corrected: string | null = null;
      try {
        const crop = await cropRegion(compressed, answer.regions[0]);
        const [maskedCropText] = maskDomainTerms(cleaned);
        corrected = await transcribeCrop(crop, maskedCropText);
      } catch {
        corrected = null;
      }
      if (corrected && corrected.trim()) {
        const restored = restoreDomainTerms(corrected, restoreMap);
        pageResult.set(answer.answerId, normalizeText(restored));
      }
    }
  }
  return pageResult;
}

/**
 * Re-read low-confidence answers using one vision call per page. Groups flagged
 * answers by page, sends the full page image + all OCR block texts to the vision
 * model in a single call, then maps corrected lines back to answers. Falls back to
 * the per-crop path if the whole-page call fails or its response doesn't parse.
 */
export async function validateTranscriptions(
  answers: ExtractedAnswer[],
  pageImages: Map<number, Buffer>,
  answerIds: string[]
): Promise<[ExtractedAnswer[], boolean]> {
  const targets = new Set(answerIds);
  if (targets.size === 0) return [answers, false];

  const byPage = new Map<number, ExtractedAnswer[]>();
  for (const answer of answers) {
    if (targets.has(answer.answerId) && answer.regions.length > 0) {
      const page = answer.regions[0].page;
      const list = byPage.get(page) ?? [];
      list.push(answer);
      byPage.set(page, list);
    }
  }

  const pageResults = await Promise.all(
    [...byPage.entries()].map(([page, pageAnswers]) => {
      const image = pageImages.get(page);
      return image === undefined
        ? Promise.resolve(new Map<string, string>())
        : processPage(page, pageAnswers, image);
    })
  );

  let used = false;
  const correctedText = new Map<string, string>();
  for (const pageResult of pageResults) {
    if (pageResult.size > 0) {
      used = true;
      for (const [id, text] of pageResult) correctedText.set(id, text);
    }
  }

  const out = answers.map((answer): ExtractedAnswer => {
    const newText = correctedText.get(answer.answerId);
    if (newText === undefined) return answer;
    // U9 — re-derive the label from the corrected text. The vision model routinely
    // restores the exact characters the label parser needed; only ever upgrades —
    // a corrected line that parses to no label leaves any existing one alone.
    const relabelled = parseAnswerLabel(newText);
    return {
      ...answer,
      normalizedText: newText,
      confidence: Math.max(answer.confidence, CONFIDENCE_AFTER_VALIDATION),
      detectedLabel: relabelled ? relabelled.normalized : answer.detectedLabel,
      detectedLabelDisplay: relabelled ? relabelled.display : answer.detectedLabelDisplay,
    };
  });
  return [out, used];
}
