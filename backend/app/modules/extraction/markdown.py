"""Markdown serialisation of the IR.

Markdown is a rendering for humans and is NEVER parsed back — round-tripping through
it is exactly how coordinates get lost (docs/pipelines/extraction.md, stage 7).
"""
from __future__ import annotations

from app.schemas.ir import IRDocument


def document_to_markdown(document: IRDocument) -> str:
    lines: list[str] = [f"# Document {document.document_id}", ""]
    for page in sorted(document.pages, key=lambda p: p.page_number):
        lines.append(f"## Page {page.page_number}")
        lines.append(
            f"<!-- extraction_method={page.extraction_method} "
            f"classification={page.classification} size={page.width:.0f}x{page.height:.0f} -->"
        )
        lines.append("")
        for block in sorted(page.blocks, key=lambda b: b.reading_order):
            marker = " <!-- low-confidence -->" if block.low_confidence else ""
            lines.append(f"{block.text}{marker}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
