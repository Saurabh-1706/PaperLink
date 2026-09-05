/**
 * The Intermediate Representation — the single source of truth downstream.
 * Port of backend/app/schemas/ir.py. Document -> Page -> Block.
 */
import type { BBox } from "./geometry";

export type BlockType = "line" | "paragraph" | "word";
export type ScriptClass = "printed" | "handwritten" | "uncertain";
export type PageClassification = "searchable" | "scanned" | "image";
export type ExtractionMethod = "text" | "ocr";

export interface IRBlock {
  blockId: string;
  text: string;
  bbox: BBox;
  confidence: number;
  blockType: BlockType;
  readingOrder: number;
  lowConfidence: boolean;
  script: ScriptClass;
  scriptScore: number;
}

export interface IRPage {
  pageNumber: number;
  width: number;
  height: number;
  dpi: number;
  classification: PageClassification;
  extractionMethod: ExtractionMethod;
  renderedImageUri: string | null;
  blocks: IRBlock[];
}

export interface IRDocument {
  documentId: string;
  kind: string;
  pageCount: number;
  pages: IRPage[];
}

export function irPageByNumber(doc: IRDocument, number: number): IRPage | undefined {
  return doc.pages.find((p) => p.pageNumber === number);
}

/** Every block in the document, page-then-reading-order — the canonical document-wide
 * reading order the question pipeline walks. Port of IRDocument.ordered_blocks(). */
export function orderedBlocks(doc: IRDocument): Array<{ page: number; block: IRBlock }> {
  const out: Array<{ page: number; block: IRBlock }> = [];
  for (const page of [...doc.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    for (const block of [...page.blocks].sort((a, b) => a.readingOrder - b.readingOrder)) {
      out.push({ page: page.pageNumber, block });
    }
  }
  return out;
}
