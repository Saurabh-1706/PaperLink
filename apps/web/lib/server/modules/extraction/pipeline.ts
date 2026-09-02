/**
 * Deterministic extraction core: bytes -> IR-JSON (+ rendered page images).
 * Port of backend/app/modules/extraction/pipeline.py, restructured around Gemini as
 * the sole OCR engine (docs/decisions/ADR-006-gemini-ocr-coordinates.md):
 *
 *  - No preprocessing pass (deskew/denoise/threshold): deferred, see the migration
 *    plan — Gemini reads skewed/lit photos far better than a local engine needed help
 *    to.
 *  - No word-level fragment clustering / script-classifier geometry signals: Gemini
 *    is asked to localize and classify whole LINES directly in one call per page, so
 *    there is nothing left to cluster.
 *  - No second-pass "vision correction": that existed to fix a *different, cheaper*
 *    OCR engine's mistakes. Once Gemini itself is the OCR engine, a second Gemini
 *    call over its own output would be circular.
 *
 * CLAUDE.md still holds: "no pipeline may require an LLM to produce a result." For a
 * SEARCHABLE page that is unconditionally true (native text extraction never calls a
 * model). For a SCANNED/handwritten page there is, by construction, no non-LLM OCR
 * left to fall back to — if the whole Gemini cascade fails, the page still gets a
 * rendered image and an explicit, flagged empty block rather than a crash (see
 * `ocrBlocks` below).
 */
import { renderPages, groupWordsIntoLines, type PageRender } from "@/lib/server/modules/documents/pdf";
import { ocrPage } from "@/lib/server/ai/ocr";
import { settings } from "@/lib/server/config";
import { safeNormalizeBbox, safeValidateFractionalBbox, type BBox } from "./geometry";
import { orderBoxes } from "./readingOrder";
import { documentToMarkdown } from "./markdown";
import type { IRBlock, IRDocument, IRPage, ScriptClass } from "./types";

export interface PageArtifact {
  pageNumber: number;
  imageBytes: Buffer;
  width: number;
  height: number;
  dpi: number;
}

export interface ExtractionOutput {
  ir: IRDocument;
  markdown: string;
  artifacts: PageArtifact[];
}

export async function extractDocument(
  data: Buffer,
  documentId: string,
  kind: string,
  opts: { dpi?: number; handwriting?: boolean } = {}
): Promise<ExtractionOutput> {
  const renders = await renderPages(data, opts.dpi);

  const processed = await Promise.all(
    renders.map(async (render) => {
      const blocks =
        render.classification === "searchable"
          ? nativeBlocks(render)
          : await ocrBlocks(render, Boolean(opts.handwriting));
      const ordered = assignReadingOrder(blocks);
      const irPage: IRPage = {
        pageNumber: render.pageNumber,
        width: render.width,
        height: render.height,
        dpi: render.dpi,
        classification: render.classification,
        extractionMethod: render.classification === "searchable" ? "text" : "ocr",
        renderedImageUri: null,
        blocks: ordered,
      };
      const artifact: PageArtifact = {
        pageNumber: render.pageNumber,
        imageBytes: render.imageBytes,
        width: render.width,
        height: render.height,
        dpi: render.dpi,
      };
      return { irPage, artifact };
    })
  );

  const pages = processed.map((p) => p.irPage).sort((a, b) => a.pageNumber - b.pageNumber);
  const artifacts = processed.map((p) => p.artifact);
  const ir: IRDocument = { documentId, kind, pageCount: pages.length, pages };
  return { ir, markdown: documentToMarkdown(ir), artifacts };
}

function nativeBlocks(render: PageRender): IRBlock[] {
  const lines = groupWordsIntoLines(render.nativeWords);
  const blocks: IRBlock[] = [];
  lines.forEach(([text, box], index) => {
    const bbox = safeNormalizeBbox(box, render.width, render.height);
    if (!bbox) return;
    blocks.push({
      blockId: `p${render.pageNumber}-b${index}`,
      text,
      bbox,
      confidence: 1,
      blockType: "line",
      readingOrder: index,
      lowConfidence: false,
      script: "uncertain",
      scriptScore: 0,
    });
  });
  return blocks;
}

async function ocrBlocks(render: PageRender, handwriting: boolean): Promise<IRBlock[]> {
  const lines = await ocrPage(render.imageBytes, handwriting);

  if (lines === null) {
    // The entire Gemini cascade failed or is cooling down. There is no local OCR
    // engine left to fall back to, so the page is flagged rather than dropped
    // silently or thrown as a hard failure.
    const bbox = safeValidateFractionalBbox([0, 0, 1, 1]);
    return bbox
      ? [
          {
            blockId: `p${render.pageNumber}-o0`,
            text: "",
            bbox,
            confidence: 0,
            blockType: "paragraph",
            readingOrder: 0,
            lowConfidence: true,
            script: "uncertain" as ScriptClass,
            scriptScore: 0,
          },
        ]
      : [];
  }

  const blocks: IRBlock[] = [];
  lines.forEach((line, index) => {
    const bbox = safeValidateFractionalBbox(line.bbox);
    if (!bbox) return;
    blocks.push({
      blockId: `p${render.pageNumber}-o${index}`,
      text: line.text,
      bbox,
      confidence: line.confidence,
      blockType: "line",
      readingOrder: index,
      // Flagged, never dropped: dropping low-confidence blocks loses handwriting.
      lowConfidence: line.confidence < settings.blockConfidenceThreshold,
      script: line.script,
      scriptScore: line.script === "handwritten" ? 1 : line.script === "printed" ? 0 : 0.5,
    });
  });
  return blocks;
}

function assignReadingOrder(blocks: IRBlock[]): IRBlock[] {
  const boxes: BBox[] = blocks.map((b) => b.bbox);
  const orderedIndices = orderBoxes(boxes);
  return orderedIndices.map((index, position) => ({ ...blocks[index], readingOrder: position }));
}
