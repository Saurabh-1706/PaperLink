/** Port of the answer-related parts of backend/app/schemas/pipeline.py. */
import type { Region } from "../common";
import type { ExtractionMethod } from "../extraction/types";

export interface ExtractedAnswer {
  answerId: string;
  rawText: string;
  normalizedText: string;
  /** Normalized form of a label the student wrote. */
  detectedLabel: string | null;
  detectedLabelDisplay: string | null;
  pageNumbers: number[];
  regions: Region[];
  confidence: number;
  extractionMethod: ExtractionMethod;
  isContinuationOf: string | null;
  blockIds: string[];
}

export interface AnswerPipelineResult {
  answers: ExtractedAnswer[];
  lowConfidenceAnswerIds: string[];
  usedLlm: boolean;
}
