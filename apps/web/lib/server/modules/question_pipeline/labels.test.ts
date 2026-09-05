import { describe, expect, it } from "vitest";
import {
  compareNormalizedNumbers,
  deduplicateNormalizedNumbers,
  extractTopInt,
  parentOf,
  parseLabel,
  romanToInt,
  sortKey,
} from "./labels";

describe("parseLabel", () => {
  it("parses a bare top-level number", () => {
    const parsed = parseLabel("11. Describe the process.");
    expect(parsed?.normalized).toBe("11");
    expect(parsed?.level).toBe(0);
    expect(parsed?.remainder).toBe("Describe the process.");
  });

  it("parses top + sub + subsub in one block", () => {
    const parsed = parseLabel("11 (a) (ii) Explain further.");
    expect(parsed?.normalized).toBe("11.a.ii");
    expect(parsed?.level).toBe(2);
  });

  it("parses a Q-prefixed number", () => {
    const parsed = parseLabel("Q5 State the law.");
    expect(parsed?.normalized).toBe("5");
  });

  it("parses a bare lettered sub-part", () => {
    const parsed = parseLabel("(a) Because of osmosis.");
    expect(parsed?.normalized).toBe("a");
    expect(parsed?.level).toBe(1);
  });

  it("parses a bare roman numeral only after every lettered reading is ruled out", () => {
    const parsed = parseLabel("ii) Write the equation.");
    expect(parsed?.normalized).toBe("ii");
    expect(parsed?.level).toBe(2);
  });

  it("returns null for prose with no label", () => {
    expect(parseLabel("This is just a sentence.")).toBeNull();
  });

  it("strips an answer prefix only when allowed", () => {
    expect(parseLabel("Ans: 11 (a) because", false)?.normalized).toBeUndefined();
    expect(parseLabel("Ans: 11 (a) because", true)?.normalized).toBe("11.a");
  });
});

describe("parseLabel — combined sub+subsub block", () => {
  it("parses `a) i) text` as sub=a, subsub=i", () => {
    const parsed = parseLabel("a) i) first point");
    expect(parsed?.normalized).toBe("a.i");
  });
});

describe("normalizeParts / normalize via parseLabel", () => {
  it("lowercases sub/subsub", () => {
    expect(parseLabel("11 (A) some text")?.normalized).toBe("11.a");
  });
});

describe("romanToInt", () => {
  it("converts simple romans", () => {
    expect(romanToInt("i")).toBe(1);
    expect(romanToInt("iv")).toBe(4);
    expect(romanToInt("ix")).toBe(9);
    expect(romanToInt("xiv")).toBe(14);
  });
});

describe("parentOf / extractTopInt", () => {
  it("computes the parent of a nested label", () => {
    expect(parentOf("11.a.ii")).toBe("11.a");
    expect(parentOf("11")).toBeNull();
  });

  it("extracts the leading integer", () => {
    expect(extractTopInt("18.a")).toBe(18);
    expect(extractTopInt("a.ii")).toBeNull();
  });
});

describe("sortKey / compareNormalizedNumbers", () => {
  it("sorts numeric, lettered and roman parts in natural order", () => {
    const numbers = ["11.b", "2", "11.a", "11.a.ii", "11.a.i", "1"];
    const sorted = [...numbers].sort(compareNormalizedNumbers);
    expect(sorted).toEqual(["1", "2", "11.a", "11.a.i", "11.a.ii", "11.b"]);
  });

  it("treats a shorter label as sorting before a longer one that extends it", () => {
    expect(compareNormalizedNumbers("11.a", "11.a.ii")).toBeLessThan(0);
  });
});

describe("deduplicateNormalizedNumbers", () => {
  it("appends a numeric suffix to repeated labels", () => {
    const questions = [
      { normalizedNumber: "14.a.ii", questionId: "q-14.a.ii" },
      { normalizedNumber: "14.a.ii", questionId: "q-14.a.ii" },
      { normalizedNumber: "14.a.ii", questionId: "q-14.a.ii" },
    ];
    const out = deduplicateNormalizedNumbers(questions);
    expect(out.map((q) => q.normalizedNumber)).toEqual(["14.a.ii", "14.a.ii.2", "14.a.ii.3"]);
  });
});

describe("sortKey", () => {
  it("treats a third-level all-roman part as numeric for sorting", () => {
    const key = sortKey("11.a.iv");
    expect(key[2]).toEqual([0, 4]);
  });
});
