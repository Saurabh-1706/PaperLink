"""Document routes. The page-image route is tenant-checked: a rendered answer sheet is
as sensitive as the text extracted from it."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.api.v1.deps import Principal, SessionDep, StorageDep, require
from app.core.errors import NotFoundError
from app.core.permissions import Permission
from app.db.repositories import DocumentRepository, PageRepository

router = APIRouter(prefix="/documents", tags=["documents"])

ReadDep = Annotated[Principal, Depends(require(Permission.READ))]


@router.get("/{document_id}/pages/{page_number}/image")
def page_image(
    document_id: str,
    page_number: int,
    principal: ReadDep,
    session: SessionDep,
    storage: StorageDep,
) -> Response:
    DocumentRepository(session).get_or_404(principal.organization_id, document_id)
    page = PageRepository(session).by_number(principal.organization_id, document_id, page_number)
    if page is None or not page.rendered_image_uri:
        raise NotFoundError("Page image not found.", document_id=document_id, page=page_number)
    image = storage.get(page.rendered_image_uri, organization_id=principal.organization_id)
    return Response(content=image, media_type="image/png")


@router.get("/{document_id}/markdown")
def document_markdown(
    document_id: str, principal: ReadDep, session: SessionDep, storage: StorageDep
) -> Response:
    """Human-readable rendering. Never parsed back — the IR is authoritative."""
    document = DocumentRepository(session).get_or_404(principal.organization_id, document_id)
    if not document.markdown_uri:
        raise NotFoundError("Markdown not available.", document_id=document_id)
    markdown = storage.get(document.markdown_uri, organization_id=principal.organization_id)
    return Response(content=markdown, media_type="text/markdown")
