/**
 * Vision-LLM transcription correction. Port of the `DocumentVisionProvider.
 * transcribe_page`/`transcribe` call sites used by
 * backend/app/modules/answer_pipeline/vision.py, collapsed into direct
 * `callWithCascade` calls following ocr.ts's shape.
 *
 * The model sees the full page image and every OCR line at once, which gives it the
 * context needed to read handwriting correctly. Coordinates are never touched
 * (ADR-001) — lines go in and out by array position only, never a bbox.
 */
import { z } from "zod";
import { callWithCascade, imagePart, textPart } from "./gemini";
import { settings } from "@/lib/server/config";

const PageResponseSchema = z.object({ lines: z.array(z.string()) });
const CropResponseSchema = z.object({ text: z.string() });

function pagePrompt(maskedLines: string[], confidences: number[]): string {
  const numbered = maskedLines
    .map((line, i) => {
      const conf = confidences[i] ?? 1;
      const flag = conf < 0.65 ? " [LOW CONFIDENCE]" : "";
      return `${i + 1}. "${line}"${flag}`;
    })
    .join("\n");
  return `You are correcting OCR transcriptions of a student's handwritten exam answers.
Below are the OCR engine's ${maskedLines.length} line(s) from this page image, in order.
Re-read the handwriting in the image and provide a corrected transcription for each
line. If a line's OCR text is already correct, return it unchanged. Tokens that look
like "__DOMAIN_0__", "__DOMAIN_1__", etc. are placeholders for exam-specific terms —
copy them through EXACTLY as written, do not translate, expand, or alter them.

OCR LINES:
${numbered}

Return ONLY JSON matching: {"lines": ["corrected line 1", "corrected line 2", ...]}
with exactly ${maskedLines.length} entries, in the same order as the input.`;
}

/** One call per page, correcting every flagged line on it at once. Returns null if
 * every model in the cascade failed or the response didn't parse to the expected
 * line count — callers must fall back to the per-crop path or the original OCR text. */
export async function transcribePage(
  imageBytes: Buffer,
  maskedLines: string[],
  confidences: number[]
): Promise<string[] | null> {
  if (maskedLines.length === 0) return null;
  const cascade = settings.geminiVisionModelCascade;
  const raw = await callWithCascade(cascade, [textPart(pagePrompt(maskedLines, confidences)), imagePart(imageBytes)]);
  if (raw === null) return null;

  const parsed = PageResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.lines.length !== maskedLines.length) return null;
  return parsed.data.lines;
}

function cropPrompt(maskedText: string): string {
  return `You are correcting an OCR transcription of a student's handwritten exam
answer. Re-read the handwriting in this cropped image and provide a corrected
transcription. If the OCR text is already correct, return it unchanged. Tokens that
look like "__DOMAIN_0__", "__DOMAIN_1__", etc. are placeholders for exam-specific
terms — copy them through EXACTLY as written, do not translate, expand, or alter them.

OCR TEXT: "${maskedText}"

Return ONLY JSON matching: {"text": "the corrected line"}`;
}

/** Fallback path when a whole-page call fails: one crop at a time. */
export async function transcribeCrop(imageBytes: Buffer, maskedText: string): Promise<string | null> {
  const cascade = settings.geminiVisionModelCascade;
  const raw = await callWithCascade(cascade, [textPart(cropPrompt(maskedText)), imagePart(imageBytes)]);
  if (raw === null) return null;

  const parsed = CropResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.text;
}
