/**
 * Segmentation regression tests built from a real handwritten answer sheet.
 *
 * The geometry below is copied verbatim from the `blocks` rows a genuine scan
 * produced (biology paper, student answering Q17/Q18 of a paper numbered from 1),
 * because the bug it pins down only appears with real handwriting: slanted lines
 * whose boxes overlap, producing NEGATIVE inter-line gaps.
 */
import { describe, expect, it } from "vitest";
import { extractAnswers } from "./pipeline";
import type { IRBlock, IRDocument } from "../extraction/types";

function block(readingOrder: number, text: string, x1: number, y1: number, y2: number): IRBlock {
  return {
    blockId: `p1-o${readingOrder}`,
    text,
    bbox: { x1, y1, x2: 0.95, y2 },
    confidence: 0.95,
    blockType: "line",
    readingOrder,
    lowConfidence: false,
    script: "handwritten",
    scriptScore: 0.9,
  } as unknown as IRBlock;
}

/** The real page: two answers ("17" with sub-parts a/b/c, "18" with sub-part a),
 * several of them wrapping onto a second line or continuing with a "*" bullet. */
function realAnswerSheet(): IRDocument {
  return {
    documentId: "d1",
    kind: "answer_sheet",
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        width: 1000,
        height: 1400,
        dpi: 200,
        classification: "scanned",
        extractionMethod: "ocr",
        renderedImageUri: null,
        blocks: [
          block(0, "17 a) 6 phosphodiester bonds are present in the double stranded", 0.015, 0.068, 0.132),
          block(1, "polynucleotide chain.", 0.118, 0.142, 0.188),
          block(2, "b) * 10 base pairs are present in each helical turn", 0.62, 0.232, 0.292),
          block(3, "* Distance between 2 base pairs = 0.34 nm = 3.4 A", 0.112, 0.335, 0.398),
          block(4, "c) * In addition to H-bonds the stacking of base pairs one", 0.062, 0.445, 0.502),
          block(5, "over the other in a double helix confers additional stability.", 0.112, 0.502, 0.558),
          block(6, "* The presence of thymine also confers additional stability.", 0.118, 0.605, 0.665),
          block(7, "18.", 0.081, 0.738, 0.772),
          block(8, "a) * Restrictions are imposed on MTP in India to check the", 0.68, 0.758, 0.862),
          block(9, "illegal female foeticide which is said to be relatively high", 0.118, 0.818, 0.882),
          block(10, "in our country.", 0.118, 0.885, 0.938),
        ],
      },
    ],
  } as unknown as IRDocument;
}

describe("answer segmentation on a real handwritten sheet", () => {
  it("keeps each labelled answer whole instead of shattering it into orphans", () => {
    const { answers } = extractAnswers(realAnswerSheet());

    // One segment per label actually written on the page: 17.a, 17.b, 17.c, 18, 18.a.
    expect(answers).toHaveLength(5);
    expect(answers.map((a) => a.detectedLabel)).toEqual(["17.a", "17.b", "17.c", "18", "18.a"]);
  });

  it("qualifies a bare sub-label with the top-level number in scope", () => {
    const { answers } = extractAnswers(realAnswerSheet());

    // The student wrote a bare "b)" / "c)" under "17 a)", and a bare "a)" under "18.".
    // Left unqualified these carry no top-level component, so the mapping engine's
    // offset resolver cannot score them and the answers go unmapped.
    const byLabel = new Map(answers.map((a) => [a.detectedLabel, a]));
    expect(byLabel.has("17.b")).toBe(true);
    expect(byLabel.has("17.c")).toBe(true);
    expect(byLabel.has("18.a")).toBe(true);
    expect(byLabel.has("b")).toBe(false);
  });

  it("keeps a bullet continuation with the answer it belongs to", () => {
    const { answers } = extractAnswers(realAnswerSheet());
    const byLabel = new Map(answers.map((a) => [a.detectedLabel, a]));

    // Q17(b) asks for the number of base pairs AND the distance between them; the
    // distance lives on the "*" bullet line underneath. Splitting it off left the
    // mapped answer incomplete and the bullet orphaned.
    expect(byLabel.get("17.b")!.rawText).toContain("10 base pairs");
    expect(byLabel.get("17.b")!.rawText).toContain("0.34 nm");

    expect(byLabel.get("17.c")!.rawText).toContain("stacking of base pairs");
    expect(byLabel.get("17.c")!.rawText).toContain("presence of thymine");

    // The wrapped tail of 18(a) stays attached too.
    expect(byLabel.get("18.a")!.rawText).toContain("in our country");
  });

  it("leaves no unlabelled orphan fragments behind", () => {
    const { answers } = extractAnswers(realAnswerSheet());
    expect(answers.filter((a) => a.detectedLabel === null)).toHaveLength(0);
  });
});

describe("line-spacing baseline", () => {
  it("ignores negative gaps from overlapping handwritten lines", () => {
    // Three tightly-spaced lines under one label, the middle pair overlapping (the
    // second line's box starts above the first line's bottom edge). Clamping that
    // negative gap to zero used to drag the baseline down and split the block apart.
    const doc = {
      documentId: "d2",
      kind: "answer_sheet",
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          width: 1000,
          height: 1400,
          dpi: 200,
          classification: "scanned",
          extractionMethod: "ocr",
          renderedImageUri: null,
          blocks: [
            block(0, "5. The first line of the answer runs across the page", 0.1, 0.10, 0.16),
            block(1, "and overlaps slightly with the line above it", 0.1, 0.15, 0.21),
            block(2, "before finishing on a third line here", 0.1, 0.255, 0.31),
          ],
        },
      ],
    } as unknown as IRDocument;

    const { answers } = extractAnswers(doc);
    expect(answers).toHaveLength(1);
    expect(answers[0].detectedLabel).toBe("5");
    expect(answers[0].rawText).toContain("third line");
  });
});
