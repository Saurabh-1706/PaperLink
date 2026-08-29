import type { PageImage, Question } from "@/types";

export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL");
  return { mediaType: match[1], base64: match[2] };
}

/**
 * LLMs transcribing multi-line content (e.g. a handwritten answer with real
 * line breaks) routinely emit a literal newline/tab inside a JSON string
 * value instead of the escaped "\n"/"\t" the JSON spec requires — strict
 * JSON.parse rejects raw control characters inside string literals, failing
 * the entire response over what's otherwise perfectly fine content. Walks
 * the text tracking string/escape state and escapes any stray control
 * character found inside a string; everything outside strings (formatting
 * whitespace between tokens, which JSON.parse already tolerates) is left
 * untouched.
 */
function escapeStrayControlChars(raw: string): string {
  let out = "";
  let inString = false;
  let escapedNext = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escapedNext) {
      out += ch;
      escapedNext = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escapedNext = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

/** Attempts to repair common LLM JSON quirks before parsing. */
function repairJson(raw: string): string {
  return (
    raw
      // Remove single-line // comments
      .replace(/\/\/[^\n]*/g, "")
      // Remove block /* */ comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Replace single-quoted strings with double-quoted ones (simple heuristic)
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`)
      // Remove trailing commas before } or ]
      .replace(/,\s*([\]}])/g, "$1")
  );
}

/**
 * Last-ditch recovery: given a truncated JSON array string, collect every
 * complete {...} object before the cut-off point and return them as a valid
 * array. This lets a 30-question answer sheet still produce 28 results even
 * when the model hits its output-token limit mid-way through the last entry.
 */
function recoverTruncatedArray(raw: string): unknown[] {
  const results: unknown[] = [];
  // Walk the string tracking brace depth; each top-level {...} that closes
  // cleanly is a complete object we can safely keep.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          results.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // Object itself is malformed — skip it.
        }
        start = -1;
      }
    }
  }
  return results;
}

/** Pulls the first {...}/[...] JSON value out of a model response, tolerating
 *  markdown code fences and stray prose the model adds around the JSON. */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in model response: ${text.slice(0, 200)}`);
  // Fix stray unescaped control characters (e.g. real newlines inside a
  // transcribed answer's "text" field) up front — must happen before the
  // bracket-matching walk below, since escaping shifts string length and
  // would otherwise misalign the index it finds.
  const trimmed = escapeStrayControlChars(candidate.slice(start));
  // Walk from the end to find the matching closing bracket for a robust parse
  // even if the model appended trailing commentary.
  let depth = 0;
  let end = -1;
  const open = trimmed[0];
  const close = open === "[" ? "]" : "}";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === open) depth++;
    else if (trimmed[i] === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const jsonStr = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    // Try once more after attempting common repairs
    const repaired = repairJson(jsonStr);
    try {
      return JSON.parse(repaired) as T;
    } catch (e2: any) {
      // Final fallback: if the response looks like a truncated array (model hit
      // its output-token limit mid-JSON), salvage every complete object that
      // was returned before the cut-off rather than failing the whole request.
      if (trimmed.startsWith("[")) {
        const recovered = recoverTruncatedArray(trimmed);
        if (recovered.length > 0) {
          console.warn(
            `[extractJson] Recovered ${recovered.length} item(s) from truncated JSON array. ` +
            `Parse error was: ${e2.message}`
          );
          return recovered as unknown as T;
        }
      }
      throw new Error(`JSON parse failed: ${e2.message}\nRaw snippet: ${jsonStr.slice(0, 300)}`);
    }
  }
}

export const QUESTION_EXTRACTION_PROMPT = `You are analyzing scanned pages of a school/college question paper.

Extract every question IN PRINTED ORDER, exactly as numbered on the page. Rules:
- Treat labelled sub-parts as SEPARATE entries. Example: "11 (a)" and "11 (b)" are two entries with numbers "11(a)" and "11(b)".
- Preserve the original numbering format exactly as printed (e.g. "1", "2.", "Q3", "11(a)", "iv)").
- If a question has a marks allocation printed (e.g. "[5 marks]", "(10)"), capture it as a number in "marks"; otherwise null.
- Include the full question text (merge text that wraps across lines or continues onto the next page).
- Do not invent questions that are not present. Do not skip any.

Respond with ONLY a JSON array, no commentary, in this exact shape:
[
  { "number": "11(a)", "text": "...", "marks": 5 }
]`;

export function buildAnswerExtractionPrompt(questions: Question[]): string {
  const questionList = questions
    .map((q) => `${q.number}: ${q.text.slice(0, 160)}`)
    .join("\n");
  return `You are analyzing scanned pages of a STUDENT's handwritten answer sheet, written in
response to the following question paper (numbers and a short excerpt of each question):

${questionList}

Each page image has a faint magenta coordinate grid burned into it: vertical lines labelled
"x0", "x10", "x20" ... "x100" along the top edge, and horizontal lines labelled "y0", "y10" ...
"y100" down the left edge. These labels are percentages of the page's width/height. DO NOT
estimate positions freehand — locate the nearest gridlines that bound the handwriting and read
the bounding box off of them directly. This grid is a coordinate reference only; ignore it when
transcribing answer text.

Your job: find every distinct block of handwritten answer content on the sheet, in whatever
order the student wrote it (students often answer out of order). For each block:
- Read any question number/label the student wrote next to or above it (e.g. "Q2", "3(b)", "Ans 5"). If no legible label exists, set "questionNumberGuess" to null and instead use the content to guess which printed question it best answers — but ONLY put a guess in "questionNumberGuess" if you are reasonably confident; otherwise leave it null and rely on "bestMatchNumber".
- Transcribe the answer text as best you can (handwriting may be imperfect; do your best, note illegible spans as [illegible]).
- Give a tight bounding box for exactly where this answer's handwriting appears, as FRACTIONS of the page (0.0-1.0 for x, y, width, height; x/y is the top-left corner) — derived from the grid labels, e.g. if the handwriting starts right at the "x10"/"y20" gridlines and ends at "x90"/"y35", report x=0.10, y=0.20, width=0.80, height=0.15. Round to the nearest gridline you can see; do not guess between them. An answer that continues onto another page must have one region entry per page it appears on, each with its own "page" index (0-based, matching the order pages were provided).
- "bestMatchNumber": the printed question number (from the list above) this answer content most plausibly responds to, based on subject matter, even if no label was written. Null if it doesn't match anything in the list at all (e.g. rough work, a doodle, an answer to a question not in the list).
- "confidence": 0 to 1, your confidence that bestMatchNumber is correct.

Also note: if a block is clearly not an answer to any listed question (stray notes, crossed-out work, an answer number that doesn't exist in the list), still report it with bestMatchNumber null so it can be shown as unmatched.

Respond with ONLY a JSON array, no commentary, in this exact shape:
[
  {
    "questionNumberGuess": "3(b)" ,
    "bestMatchNumber": "3(b)",
    "confidence": 0.9,
    "text": "transcribed answer text...",
    "regions": [ { "page": 0, "x": 0.08, "y": 0.42, "width": 0.85, "height": 0.15 } ]
  }
]`;
}

export const GRADING_SYSTEM_NOTE = `When grading, be a fair, encouraging examiner. For each matched
answer, decide isCorrect (true/false/null if not gradable e.g. opinion questions), a score out of
the question's marks (or out of 5 if marks unknown), and 1-2 sentences of specific feedback.`;

export function buildGradingPrompt(
  questions: Question[],
  answers: { questionNumber: string; text: string }[]
): string {
  const pairs = questions
    .map((q) => {
      const a = answers.find((x) => x.questionNumber === q.number);
      return `Q${q.number} (${q.marks ?? "?"} marks): ${q.text}\nStudent answer: ${
        a ? a.text : "[NO ANSWER FOUND]"
      }`;
    })
    .join("\n---\n");

  return `${GRADING_SYSTEM_NOTE}

${pairs}

Respond with ONLY a JSON array (skip entries with [NO ANSWER FOUND]), in this exact shape:
[
  { "questionNumber": "11(a)", "isCorrect": true, "score": 4, "maxScore": 5, "feedback": "..." }
]`;
}

export function toImagePart(img: PageImage) {
  return parseDataUrl(img.dataUrl);
}
