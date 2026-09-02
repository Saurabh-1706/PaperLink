import { describe, expect, it } from "vitest";
import { documentToMarkdown } from "./markdown";
import type { IRDocument } from "./types";

describe("documentToMarkdown", () => {
  it("renders pages and blocks in order, flagging low-confidence blocks", () => {
    const doc: IRDocument = {
      documentId: "doc-1",
      kind: "question_paper",
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          width: 100,
          height: 200,
          dpi: 150,
          classification: "searchable",
          extractionMethod: "text",
          renderedImageUri: null,
          blocks: [
            {
              blockId: "p1-b1",
              text: "second line",
              bbox: { x1: 0, y1: 0.2, x2: 1, y2: 0.3 },
              confidence: 1,
              blockType: "line",
              readingOrder: 1,
              lowConfidence: false,
              script: "uncertain",
              scriptScore: 0,
            },
            {
              blockId: "p1-b0",
              text: "first line",
              bbox: { x1: 0, y1: 0, x2: 1, y2: 0.1 },
              confidence: 0.4,
              blockType: "line",
              readingOrder: 0,
              lowConfidence: true,
              script: "handwritten",
              scriptScore: 1,
            },
          ],
        },
      ],
    };

    const markdown = documentToMarkdown(doc);
    const firstLineIndex = markdown.indexOf("first line");
    const secondLineIndex = markdown.indexOf("second line");

    expect(markdown).toContain("# Document doc-1");
    expect(markdown).toContain("## Page 1");
    expect(markdown).toContain("first line <!-- low-confidence -->");
    expect(markdown).toContain("second line");
    expect(firstLineIndex).toBeLessThan(secondLineIndex);
  });
});
