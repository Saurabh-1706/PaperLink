"""Document ingestion: validate -> dedupe -> render/extract -> persist IR."""
from __future__ import annotations

from dataclasses import dataclass

from app.ai.ocr.base import OCREngine
from app.core.logging import get_logger
from app.db.models import Block, Document, Page
from app.db.repositories import BlockRepository, DocumentRepository, PageRepository
from app.db.session import UnitOfWork
from app.modules.documents.validation import validate_pdf
from app.modules.extraction.pipeline import extract_document
from app.schemas.common import DocumentKind
from app.schemas.ir import IRDocument
from app.storage.base import StorageBackend

log = get_logger(__name__)


@dataclass
class IngestResult:
    document: Document
    ir: IRDocument
    created: bool


class DocumentService:
    def __init__(self, session: UnitOfWork, storage: StorageBackend) -> None:
        self.session = session
        self.storage = storage
        self.documents = DocumentRepository(session)
        self.pages = PageRepository(session)
        self.blocks = BlockRepository(session)

    def ingest(
        self,
        *,
        organization_id: str,
        assessment_id: str,
        kind: DocumentKind,
        data: bytes,
        created_by: str | None = None,
        declared_mime: str | None = None,
        ocr_engine: OCREngine | None = None,
    ) -> IngestResult:
        validated = validate_pdf(data, declared_mime)

        log.info("ingest started", extra={"assessment_id": assessment_id, "kind": str(kind), "pages": validated.page_count})

        existing = self.documents.by_checksum(
            organization_id, assessment_id, str(kind), validated.checksum
        )
        if existing is not None:
            log.info("ingest skipped (duplicate)", extra={"assessment_id": assessment_id, "kind": str(kind), "document_id": existing.id})
            # Idempotent: re-uploading an identical file must not re-run OCR.
            return IngestResult(document=existing, ir=self.load_ir(existing), created=False)

        document = Document(
            organization_id=organization_id,
            created_by=created_by,
            assessment_id=assessment_id,
            kind=str(kind),
            storage_uri="",
            page_count=validated.page_count,
            mime=validated.mime,
            checksum=validated.checksum,
        )
        self.documents.add(document)
        meta = {
            "organization_id": organization_id,
            "assessment_id": assessment_id,
            "document_id": document.id,
            "kind": str(kind),
        }
        document.storage_uri = self.storage.put(
            f"{organization_id}/{assessment_id}/{document.id}/source.pdf", data, meta
        )

        output = extract_document(
            data,
            document_id=document.id,
            kind=str(kind),
            ocr_engine=ocr_engine,
            handwriting=kind == DocumentKind.ANSWER_SHEET,
        )

        for artifact in output.artifacts:
            uri = self.storage.put(
                f"{organization_id}/{assessment_id}/{document.id}/pages/{artifact.page_number}.png",
                artifact.image_bytes,
                {**meta, "page_number": artifact.page_number},
            )
            ir_page = output.ir.page(artifact.page_number)
            assert ir_page is not None
            ir_page.rendered_image_uri = uri

        document.ir_uri = self.storage.put(
            f"{organization_id}/{assessment_id}/{document.id}/ir.json",
            output.ir.model_dump_json(indent=2).encode(),
            meta,
        )
        document.markdown_uri = self.storage.put(
            f"{organization_id}/{assessment_id}/{document.id}/document.md",
            output.markdown.encode(),
            meta,
        )
        classifications = {page.classification for page in output.ir.pages}
        document.classification = (
            next(iter(classifications)) if len(classifications) == 1 else "mixed"
        )

        self._persist_ir(organization_id, created_by, document, output.ir)
        self.session.flush()
        log.info("ingest complete", extra={"assessment_id": assessment_id, "kind": str(kind), "document_id": document.id})
        return IngestResult(document=document, ir=output.ir, created=True)

    def _persist_ir(
        self, organization_id: str, created_by: str | None, document: Document, ir: IRDocument
    ) -> None:
        for ir_page in ir.pages:
            page = Page(
                organization_id=organization_id,
                created_by=created_by,
                document_id=document.id,
                page_number=ir_page.page_number,
                width=ir_page.width,
                height=ir_page.height,
                dpi=ir_page.dpi,
                classification=str(ir_page.classification),
                extraction_method=str(ir_page.extraction_method),
                rendered_image_uri=ir_page.rendered_image_uri,
            )
            self.pages.add(page)
            for ir_block in ir_page.blocks:
                self.blocks.add(
                    Block(
                        organization_id=organization_id,
                        created_by=created_by,
                        page_id=page.id,
                        block_key=ir_block.block_id,
                        text=ir_block.text,
                        bbox=ir_block.bbox.as_list(),
                        confidence=ir_block.confidence,
                        block_type=str(ir_block.block_type),
                        reading_order=ir_block.reading_order,
                        low_confidence=ir_block.low_confidence,
                    )
                )

    def load_ir(self, document: Document) -> IRDocument:
        if not document.ir_uri:
            return IRDocument(document_id=document.id, kind=document.kind, page_count=0, pages=[])
        raw = self.storage.get(document.ir_uri, organization_id=document.organization_id)
        return IRDocument.model_validate_json(raw.decode())

    def page_images(self, organization_id: str, document: Document) -> dict[int, bytes]:
        images: dict[int, bytes] = {}
        for page in self.pages.for_document(organization_id, document.id):
            if page.rendered_image_uri:
                images[page.page_number] = self.storage.get(
                    page.rendered_image_uri, organization_id=organization_id
                )
        return images
