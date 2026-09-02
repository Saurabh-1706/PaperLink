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
