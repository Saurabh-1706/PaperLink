/**
 * Gemini-as-OCR-engine for scanned/handwritten pages. Replaces PaddleOCR entirely
 * (docs/decisions/ADR-006-gemini-ocr-coordinates.md) — there is no local detector
 * left, so this is the only source of text + bounding boxes for a non-searchable
 * page. One call per page returns every line at once (line-level, not word-level:
 * Gemini is asked to localize whole lines directly, which is why this module has no
 * fragment-grouping step the way the old word-level OCR engine port would have
 * needed one).
 *
 * The returned bbox is normalised [0,1] against the image Gemini was actually shown
 * (the rendered page PNG). Because that PNG is a uniform-scale render of the whole
 * original page — no cropping, no distortion — a fractional box on it is already the
 * same fractional box against the page's own original dimensions
 * (docs/03-coordinate-contract.md), so no extra pixel-space scaling step is needed
 * the way the old preprocessed-image-space OCR engine required one.
 */
import { z } from "zod";
import { callWithCascade, imagePart, textPart } from "./gemini";
import { settings } from "@/lib/server/config";

const LineSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number().min(0).max(1),
  script: z.enum(["printed", "handwritten", "uncertain"]).default("uncertain"),
});

const ResponseSchema = z.object({ lines: z.array(LineSchema) });

export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
  script: "printed" | "handwritten" | "uncertain";
}

const PROMPT = `You are an OCR engine for exam documents (question papers and student
answer sheets, print or handwriting). Read every line of text on this page image, in
top-to-bottom, left-to-right reading order.

For each line return:
- "text": the transcribed text, exactly as written (preserve spelling, numbering like
  "1.", "(a)", "Q2", and domain terms exactly as they appear).
- "bbox": [x1, y1, x2, y2], the line's bounding box as FRACTIONS of this image's own
  width and height, each in [0, 1], origin at the top-left corner, x1<x2 and y1<y2.
- "confidence": your own confidence in the transcription, in [0, 1]. Lower it for
  unclear handwriting, smudges, or ambiguous characters — do not just default to 1.
- "script": "printed", "handwritten", or "uncertain".

Return ONLY JSON matching: {"lines": [{"text": string, "bbox": [number,number,number,number], "confidence": number, "script": string}, ...]}
Do not merge multiple lines into one entry. Do not invent lines that are not on the page.`;

/** Runs Gemini OCR over one rendered page image. Returns null if every model in the
 * cascade failed/is cooling down — callers must fall back (no pipeline may *require*
 * an LLM to produce a result). */
export async function ocrPage(imageBytes: Buffer, handwriting: boolean): Promise<OcrLine[] | null> {
  const cascade = handwriting ? settings.geminiVisionModelCascade : settings.geminiModelCascade;
  const raw = await callWithCascade(cascade, [textPart(PROMPT), imagePart(imageBytes)]);
  if (raw === null) return null;

  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.lines;
}
