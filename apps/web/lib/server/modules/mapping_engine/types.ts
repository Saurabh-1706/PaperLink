/** Port of the mapping-related parts of backend/app/schemas/pipeline.py. */
import type { MappingType, Region, ReviewStatus } from "../common";

/** What makes a low-confidence mapping reviewable rather than merely doubtful. */
export interface MappingEvidence {
  stage: string;
  labelScore: number;
  spatialScore: number;
  semanticScore: number;
  combinedScore: number;
  runnerUpScore: number | null;
  runnerUpQuestionId: string | null;
  llmVerdict: string | null;
  notes: string[];
}

export interface Mapping {
  questionId: string | null;
  answerId: string | null;
  mappingType: MappingType;
  confidence: number;
  reviewStatus: ReviewStatus;
  regions: Region[];
  evidence: MappingEvidence;
}

export interface MappingResult {
  mappings: Mapping[];
  usedLlm: boolean;
}
