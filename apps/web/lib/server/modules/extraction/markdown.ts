/**
 * Markdown serialisation of the IR. Port of backend/app/modules/extraction/markdown.py.
 * A rendering for humans, never parsed back — round-tripping through it is exactly
 * how coordinates get lost.
 */
import type { IRDocument } from "./types";

export function documentToMarkdown(document: IRDocument): string {
  const lines: string[] = [`# Document ${document.documentId}`, ""];
  const pages = [...document.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of pages) {
    lines.push(`## Page ${page.pageNumber}`);
    lines.push(
      `<!-- extraction_method=${page.extractionMethod} classification=${page.classification} ` +
        `size=${page.width.toFixed(0)}x${page.height.toFixed(0)} -->`
    );
    lines.push("");
    const blocks = [...page.blocks].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const block of blocks) {
      const marker = block.lowConfidence ? " <!-- low-confidence -->" : "";
      lines.push(`${block.text}${marker}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}
