/**
 * Document ingestion: validate -> dedupe -> render/extract -> persist IR.
 * Port of backend/app/modules/documents/service.py.
 */
import type { UnitOfWork } from "@/lib/server/db/session";
import { newOrgOwned } from "@/lib/server/db/base";
import { DocumentRepository, PageRepository, BlockRepository } from "@/lib/server/db/repositories";
import type { Document, Page, Block } from "@/lib/server/db/models";
import { GridFSStorage } from "@/lib/server/storage/gridfs";
import { validatePdf } from "./validation";
import { extractDocument } from "@/lib/server/modules/extraction/pipeline";
import { bboxToList } from "@/lib/server/modules/extraction/geometry";
import type { IRDocument } from "@/lib/server/modules/extraction/types";

export interface IngestResult {
  document: Document;
  ir: IRDocument;
  created: boolean;
}

export class DocumentService {
  private documents: DocumentRepository;
  private pages: PageRepository;
  private blocks: BlockRepository;

  constructor(private session: UnitOfWork, private storage: GridFSStorage) {
    this.documents = new DocumentRepository(session);
    this.pages = new PageRepository(session);
    this.blocks = new BlockRepository(session);
  }

  async ingest(opts: {
    organizationId: string;
    assessmentId: string;
    kind: "question_paper" | "answer_sheet";
    data: Buffer;
    createdBy?: string | null;
  }): Promise<IngestResult> {
    const { organizationId, assessmentId, kind, data, createdBy = null } = opts;
    const validated = await validatePdf(data);

    const existing = await this.documents.byChecksum(organizationId, assessmentId, kind, validated.checksum);
    if (existing) {
      // Idempotent: re-uploading an identical file must not re-run OCR.
      return { document: existing, ir: await this.loadIr(existing), created: false };
    }

    // `add()` tracks a shallow *copy* of the entity, not the object passed in — every
    // later mutation must go through the returned reference or it never reaches the
    // copy that flush() actually writes (this previously left storageUri/irUri/
    // markdownUri/classification stuck at their initial values forever, since all
    // four are only known after this point).
    const document: Document = this.documents.add({
      ...newOrgOwned(organizationId, createdBy),
      assessmentId,
      kind,
      storageUri: "",
      pageCount: validated.pageCount,
      mime: validated.mime,
      checksum: validated.checksum,
      classification: null,
      markdownUri: null,
      irUri: null,
    });

    const meta = { organizationId, assessmentId, documentId: document.id, kind };
    document.storageUri = await this.storage.put(
      `${organizationId}/${assessmentId}/${document.id}/source.pdf`,
      data,
      meta
    );

    const output = await extractDocument(data, document.id, kind, {
      handwriting: kind === "answer_sheet",
    });

    for (const artifact of output.artifacts) {
      const uri = await this.storage.put(
        `${organizationId}/${assessmentId}/${document.id}/pages/${artifact.pageNumber}.png`,
        artifact.imageBytes,
        { ...meta, pageNumber: artifact.pageNumber }
      );
      const irPage = output.ir.pages.find((p) => p.pageNumber === artifact.pageNumber);
      if (irPage) irPage.renderedImageUri = uri;
    }

    document.irUri = await this.storage.put(
      `${organizationId}/${assessmentId}/${document.id}/ir.json`,
      Buffer.from(JSON.stringify(output.ir, null, 2)),
      meta
    );
    document.markdownUri = await this.storage.put(
      `${organizationId}/${assessmentId}/${document.id}/document.md`,
      Buffer.from(output.markdown),
      meta
    );

    const classifications = new Set(output.ir.pages.map((p) => p.classification));
    document.classification = classifications.size === 1 ? [...classifications][0] : "mixed";

    await this.persistIr(organizationId, createdBy, document, output.ir);
    await this.session.flush();
    return { document, ir: output.ir, created: true };
  }

  private async persistIr(
    organizationId: string,
    createdBy: string | null,
    document: Document,
    ir: IRDocument
  ): Promise<void> {
    for (const irPage of ir.pages) {
      const page: Page = {
        ...newOrgOwned(organizationId, createdBy),
        documentId: document.id,
        pageNumber: irPage.pageNumber,
        width: irPage.width,
        height: irPage.height,
        dpi: irPage.dpi,
        classification: irPage.classification,
        extractionMethod: irPage.extractionMethod,
        renderedImageUri: irPage.renderedImageUri,
      };
      this.pages.add(page);
      for (const irBlock of irPage.blocks) {
        const block: Block = {
          ...newOrgOwned(organizationId, createdBy),
          pageId: page.id,
          blockKey: irBlock.blockId,
          text: irBlock.text,
          bbox: bboxToList(irBlock.bbox),
          confidence: irBlock.confidence,
          blockType: irBlock.blockType,
          readingOrder: irBlock.readingOrder,
          lowConfidence: irBlock.lowConfidence,
          script: irBlock.script,
          scriptScore: irBlock.scriptScore,
        };
        this.blocks.add(block);
      }
    }
  }

  async loadIr(document: Document): Promise<IRDocument> {
    if (!document.irUri) {
      return { documentId: document.id, kind: document.kind, pageCount: 0, pages: [] };
    }
    const raw = await this.storage.get(document.irUri, document.organizationId);
    return JSON.parse(raw.toString("utf-8")) as IRDocument;
  }

  async pageImages(organizationId: string, document: Document): Promise<Map<number, Buffer>> {
    const images = new Map<number, Buffer>();
    const pages = await this.pages.forDocument(organizationId, document.id);
    for (const page of pages) {
      if (page.renderedImageUri) {
        images.set(page.pageNumber, await this.storage.get(page.renderedImageUri, organizationId));
      }
    }
    return images;
  }
}
