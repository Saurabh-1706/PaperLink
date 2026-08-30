# Phase 11 — Accuracy & Performance Upgrades

**Status:** In progress
**Triggered by:** Full 27-page e2e run on `Biology.pdf` + `question-paper.pdf`
**Baseline:** 61% mapping accuracy, 25.6% marks awarded, 13 min runtime

Evidence for every item comes from `var/e2e-full/report.json` and source-code
inspection — nothing here is speculative.

---

## Upgrade index

| # | Title | Priority | Status |
|---|---|---|---|
| U1 | Segmentation noise filter | 🔴 Critical | Done |
| U2 | Question-number offset resolver in label matching | 🔴 Critical | Done |
| U3 | Parallel vision validation | 🔴 Critical | Done |
| U4 | Semantic scoring on vision-corrected text | 🟡 Medium | Done |
| U5 | Provisional grading for `needs_review` mappings | 🟡 Medium | Done |
| U6 | Switch vision calls to Gemini to avoid Groq quota | 🟡 Medium | Done |
| U7 | Fix `14.a.ii'` invalid normalised label | 🟢 Low | Done |

---

## U1 — Segmentation noise filter

**File:** `app/modules/answer_pipeline/pipeline.py`

**Problem:** The segmenter emits 178 blocks from 27 pages; 125 (70%) are unmatched
noise — MCQ option lines (`1. (D) 23S rRNA`), section headers (`SECTION-A`), lone
page-number digits, and diagram labels. Every noise block enters the 49×174 assignment
matrix, inflating solve time and stealing slots from real answers.

**Root cause:** `_segment_page` starts a new segment on any block whose text matches
`parse_label()` OR whose vertical gap exceeds `GAP_FACTOR`. MCQ lines all have labels;
headers and digits all have large gaps above them.

**Fix:** Drop blocks before segmentation when they match a noise pattern:
- Lone digit / single letter (page numbers, MCQ option letters)
- `SECTION-[A-Z]` / `SECTION - [A-Z]` headers
- MCQ format `N. (X) text` on pages classified as `searchable` (printed, not handwritten)
- Blocks shorter than 4 characters with confidence < 0.6

**Expected impact:** Unmatched count 125 → < 20; mapping matrix shrinks from 49×174
to ~49×55; mapping stage time drops proportionally.

---

## U2 — Question-number offset resolver

**File:** `app/modules/mapping_engine/stages.py`

**Problem:** `label_score()` does exact string equality. The answer sheet uses the
original exam numbering (Q17, Q18, Q19 …) while the question paper is a renumbered
subset (Q1, Q2, Q3 …). `"18" != "2.a"` so `label_score` returns 0.0 for ~15 answers
that are actually correct, forcing the mapper to rely on spatial guessing at conf ~0.72.

**Root cause:** No offset normalisation exists between the two numbering schemes.

**Fix:** Before the mapping solve, scan all `(question.normalized_number,
answer.detected_label)` pairs where a direct match exists (label_score = 1.0). Derive
the integer offset between the two schemes (e.g. answer label `"17"` matches question
`"1"` → offset = 16). Apply the offset when comparing labels for all remaining answers.

**Expected impact:** ~15 more direct matches at conf 0.97 instead of spatial at 0.72;
overall mapping accuracy 61% → ~78%.

---

## U3 — Parallel vision validation

**File:** `app/modules/answer_pipeline/vision.py`

**Problem:** `validate_transcriptions` iterates `by_page` sequentially — one blocking
`provider.transcribe_page()` call per page. With 27 pages at ~20 s/call that is 540 s.
The OCR extraction stage already uses `ThreadPoolExecutor(max_workers=4)` for the same
pattern.

**Root cause:** No concurrency in the vision loop.

**Fix:** Wrap the per-page vision calls in `ThreadPoolExecutor(max_workers=3)`. Three
concurrent Groq requests stay well within the per-minute rate limit while cutting wall
time by ~3×.

**Expected impact:** Answer pipeline 542 s → ~180 s; total run 13 min → ~5 min.

---

## U4 — Semantic scoring on vision-corrected text

**File:** `app/modules/mapping_engine/stages.py`

**Problem:** `semantic_stage_score` scores 0.03–0.13 across the board because it
compares clean question text against OCR-garbled answer text. The vision correction
step runs before mapping and writes clean text into `normalized_text`, but the semantic
scorer needs to be confirmed it reads `normalized_text` not `raw_text`.

**Root cause:** Semantic scores are too low to influence the combined score meaningfully
(weight 0.20 × score 0.05 = 0.01 contribution).

**Fix:** Confirm `semantic_stage_score` reads `answer.normalized_text`. If it already
does, raise the semantic weight from `0.20` to `0.25` and lower spatial from `0.25` to
`0.20` so corrected-text similarity has more influence on unlabelled answers.

**Expected impact:** Unlabelled answers with correct content get +0.03–0.05 confidence
boost, pushing some from `needs_review` to `auto_accepted`.

---

## U5 — Provisional grading for `needs_review` mappings

**File:** `app/modules/grading/engine.py`

**Problem:** The review gate skips grading entirely for `needs_review` mappings. 16
questions are in `needs_review` with confidence 0.62–0.69 — just below the 0.70
threshold — and many are correctly mapped. They score 0 and are invisible to the
teacher.

**Root cause:** Binary gate: either `auto_accepted` (graded) or `needs_review`
(skipped). No middle ground.

**Fix:** Grade `needs_review` mappings but set `method="provisional"` and prepend
`"[PROVISIONAL — mapping unconfirmed] "` to the feedback. The teacher sees a score
with a clear warning rather than a blank.

**Expected impact:** 16 more questions get a grade; teacher workload for review drops
because they see a starting score rather than nothing.

---

## U6 — Switch vision calls to Gemini

**File:** `.env` / `app/core/config.py`

**Problem:** All vision calls go to Groq (`VISION_PROVIDER=auto` follows
`LLM_PROVIDER=groq`). Groq's free tier has a daily token cap that is exhausted by the
vision validation stage (27 pages × ~2 000 tokens/page), leaving the grading stage
with no LLM budget.

**Root cause:** `VISION_PROVIDER=auto` inherits the text provider. Groq's vision quota
is smaller than Gemini's.

**Fix:** Set `VISION_PROVIDER=gemini` in `.env`. The `GEMINI_API_KEY` is already
present. The `vision_provider` config field and the factory already support this — it
is a one-line env change, no code change required (ADR-004).

**Expected impact:** Grading LLM calls no longer hit the cooldown breaker; all
auto-accepted mappings get LLM-graded rather than falling back to deterministic.

---

## U7 — Fix `14.a.ii'` invalid normalised label

**File:** `app/modules/question_pipeline/labels.py`

**Problem:** Two sub-questions are both labelled `ii)` under Q14.a. The normaliser
appends an apostrophe to disambiguate (`14.a.ii'`). An apostrophe is never written by
a student, so this question can never receive a direct label match and is permanently
`unanswered`.

**Root cause:** Disambiguation uses `'` suffix which is not a valid label character.

**Fix:** Use a numeric suffix: `14.a.ii.2` for the second occurrence. Update
`normalize_label` to detect duplicate normalised labels within the same parent and
append `.2`, `.3` etc.

**Expected impact:** `q-14.a.ii'` becomes matchable; one permanently unanswered
question is resolved.

---

## Acceptance criteria

After all upgrades, re-run:

```bash
python -m app.scripts.e2e_pipeline \
    --questions ../data/question-paper.pdf \
    --answers ../data/Biology.pdf \
    --out ./var/e2e-upgrade \
    --json ./var/e2e-upgrade/report.json
```

Pass criteria:

| Metric | Baseline | Target |
|---|---|---|
| Unmatched answer blocks | 125 | < 25 |
| Direct label matches | 16 / 49 | > 28 / 49 |
| Overall mapping accuracy | ~61% | > 78% |
| Answer pipeline time | 542 s | < 200 s |
| Total pipeline time | ~790 s | < 350 s |
| Marks awarded (graded) | 24.1 / 94 | > 45 / 94 |
