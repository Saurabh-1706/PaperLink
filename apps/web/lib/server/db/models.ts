/**
 * Entity shapes. Port of backend/app/db/models/{core,content}.py.
 * `bbox` fields store the normalised [x1,y1,x2,y2] list — the coordinate contract
 * holds at the storage layer too (docs/03-coordinate-contract.md).
 */
import type { Entity, OrgOwned } from "./base";

export interface Organization extends Entity {
  name: string;
}

export interface User extends OrgOwned {
  email: string;
  hashedPassword: string;
  isActive: boolean;
}

export interface Assessment extends OrgOwned {
  title: string;
  status: string;
  questionDocId: string | null;
  answerDocId: string | null;
}

export interface Job extends OrgOwned {
  assessmentId: string;
  stage: string;
  status: string;
  progress: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface Document extends OrgOwned {
  assessmentId: string;
  kind: string;
  storageUri: string;
  pageCount: number;
  mime: string;
  checksum: string;
  classification: string | null;
  markdownUri: string | null;
  irUri: string | null;
}

export interface Page extends OrgOwned {
  documentId: string;
  pageNumber: number;
  width: number;
  height: number;
  dpi: number;
  classification: string;
  extractionMethod: string;
  renderedImageUri: string | null;
}

export interface Block extends OrgOwned {
  pageId: string;
  blockKey: string;
  text: string;
  bbox: number[];
  confidence: number;
  blockType: string;
  readingOrder: number;
  lowConfidence: boolean;
  script: string;
  scriptScore: number;
}

export interface Question extends OrgOwned {
  assessmentId: string;
  externalId: string;
  displayNumber: string;
  normalizedNumber: string;
  parentId: string | null;
  text: string;
  orderIndex: number;
  optional: boolean;
  maxMarks: number | null;
  confidence: number;
}

export interface QuestionRegion extends OrgOwned {
  questionId: string;
  pageNumber: number;
  bbox: number[];
}

export interface Answer extends OrgOwned {
  assessmentId: string;
  externalId: string;
  rawText: string;
  normalizedText: string;
  detectedLabel: string | null;
  confidence: number;
  extractionMethod: string;
  isContinuationOf: string | null;
}

export interface AnswerRegion extends OrgOwned {
  answerId: string;
  pageNumber: number;
  bbox: number[];
}

export interface MappingRow extends OrgOwned {
  assessmentId: string;
  questionId: string | null;
  answerId: string | null;
  mappingType: string;
  confidence: number;
  reviewStatus: string;
  evidence: Record<string, unknown>;
}

export interface GradeRow extends OrgOwned {
  mappingId: string;
  score: number;
  maxScore: number;
  rubric: Record<string, unknown>;
  feedback: string;
  method: string;
}
