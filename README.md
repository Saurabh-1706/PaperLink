# AI Assessment Extraction & Answer Mapping

Upload a printed question paper and a student's handwritten answer sheet (PDF or images).
The app extracts every question in printed order, extracts the student's answers, maps each
answer to its question (even if answered out of order), grades what it can, and lets a teacher
click a question to see the exact highlighted region on the answer sheet.

## How it works

1. **Client-side rendering** — both uploads are rendered to page images in the browser with
   `pdfjs-dist` (a plain image file is just used as-is). Nothing is uploaded to a server until
   this step is done, and no file is ever persisted — everything lives in React state for the
   session ([lib/pdf.ts](lib/pdf.ts)).
2. **Question extraction** — the question paper's page images go to a vision-capable LLM, which
   returns every question in printed order, splitting labelled sub-parts (`11(a)`, `11(b)`) into
   separate entries ([app/api/extract-questions](app/api/extract-questions/route.ts)).
3. **Answer extraction** — the answer sheet's page images + the question list go to the same
   model, which returns every handwritten answer block it finds, each with a best-guess matching
   question number, a transcription, a confidence score, and normalized bounding box(es) — one
   region per page for answers that span multiple pages
   ([app/api/extract-answers](app/api/extract-answers/route.ts)).
4. **Mapping** — answers are joined to questions by (normalized) question number, not by
   position, so out-of-order answers still map correctly. Questions with no matching answer are
   `unanswered`; answer blocks that don't match any known question are surfaced separately as
   `unmatched` rather than silently dropped ([lib/mapping.ts](lib/mapping.ts)).
5. **Grading** — for every answered question, a second LLM call grades correctness, a score, and
   short feedback. Grading is best-effort: if it fails, mapping/highlighting still works
   ([app/api/grade](app/api/grade/route.ts)).
6. **UI** — a two-column view: questions with status badges (answered / unanswered, correct /
   incorrect, score) on the left, the answer sheet image with an accent-colored overlay box on
   the right. Clicking a question jumps to the right page and draws the highlight; unmatched
   answers get their own panel below.

## AI model / API

Pluggable via `AI_PROVIDER` env var — pick whichever key you have:

- **Google Gemini** (`AI_PROVIDER=gemini`, `GEMINI_API_KEY`) — `gemini-2.0-flash` by default. Free
  tier at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **Anthropic Claude** (`AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`) — `claude-sonnet-4-5` by
  default. Get a key at [console.anthropic.com](https://console.anthropic.com/).
- **OpenAI** (`AI_PROVIDER=openai`, `OPENAI_API_KEY`) — `gpt-4o-mini` by default (vision-capable,
  cheap). Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Note
  OpenAI's free tier is limited/trial-credit based, not an ongoing free tier like Gemini's.

See [lib/ai/provider.ts](lib/ai/provider.ts) — swapping providers is a one-line env change, no
code change, thanks to the shared `AiProvider` interface.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in AI_PROVIDER + the matching API key
npm run dev
```

Open http://localhost:3000.

## Deploying

Any Next.js host works (Vercel is the path of least resistance):

```bash
npm i -g vercel
vercel
# then in the Vercel project settings, add AI_PROVIDER and the matching API key
```

No database and no auth are required — this app deliberately keeps everything in-memory /
client-side per the assignment's constraints.

## Assumptions & limitations

- Handwriting OCR quality depends entirely on the underlying model and scan clarity; messy
  handwriting or low-resolution photos will degrade transcription and bounding-box precision.
- Question-to-answer matching relies primarily on the question number/label the student wrote.
  When no legible label exists, the model falls back to matching by subject-matter content, which
  is inherently less reliable — its confidence score is exposed but not currently surfaced as a
  visible "low confidence" warning in the UI.
- Only one student answer sheet is supported per run (as scoped by the assignment); the question
  paper and answer sheet are each single documents that may span multiple pages.
- Grading is a best-effort LLM judgment, not authoritative — it's provided as a starting point for
  the teacher, not a final grade.
- No data is stored server-side; refreshing the page loses the current session's results.
