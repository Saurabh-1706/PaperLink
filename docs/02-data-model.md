# Data Model

**Status:** Implemented (Phase 1–7)

MongoDB. Every collection carries `organization_id`, `created_by`, `created_at`,
`updated_at`. Every repository method takes `organization_id` as a **required**
argument, and the base asserts the filter carries it before the query reaches Mongo —
there is no unscoped read path. See [05-rbac.md](05-rbac.md).

## Entities

One collection per entity; `_id` is a hex uuid (readable in logs, stable across
export/import, no ObjectId/string coercion bugs). Binaries — source PDFs, rendered page
images, IR-JSON and markdown — live in GridFS in the same database, so a document and
its bytes are backed up, restored and dropped together.

| Collection | Key fields |
|---|---|
| `organizations` | `id`, `name` |
| `users` | `id`, `org_id`, `email`, `hashed_password`, `role` (`admin`/`teacher`/`reviewer`) |
| `assessments` | `id`, `org_id`, `title`, `status`, `question_doc_id`, `answer_doc_id` |
| `documents` | `id`, `org_id`, `assessment_id`, `kind` (`question_paper`/`answer_sheet`), `storage_uri`, `page_count`, `mime`, `checksum`, `classification` |
| `pages` | `id`, `document_id`, `page_number`, `width`, `height`, `dpi`, `rendered_image_uri`, `extraction_method` |
| `blocks` | `id`, `page_id`, `text`, `bbox` (float[4]), `confidence`, `block_type`, `reading_order` |
| `questions` | `id`, `assessment_id`, `display_number`, `normalized_number`, `parent_id`, `text`, `order_index`, `optional`, `max_marks`, `confidence` |
| `question_regions` | `id`, `question_id`, `page_number`, `bbox` |
| `answers` | `id`, `assessment_id`, `raw_text`, `normalized_text`, `detected_label`, `confidence`, `extraction_method`, `is_continuation_of` |
| `answer_regions` | `id`, `answer_id`, `page_number`, `bbox` |
| `mappings` | `id`, `assessment_id`, `question_id` (nullable), `answer_id` (nullable), `mapping_type`, `confidence`, `review_status`, `evidence` (sub-document) |
| `grades` | `id`, `mapping_id`, `score`, `max_score`, `rubric` (sub-document), `feedback` |
| `jobs` | `id`, `assessment_id`, `stage`, `status`, `progress`, `error`, `started_at`, `finished_at` |

## Indexes

Declared in `app/db/session.py` and applied by `make indexes`.

| Collection | Index | Unique |
|---|---|---|
| `users` | `organization_id + email` | yes |
| `users` | `email` | no (login, the one unscoped lookup) |
| `documents` | `organization_id + assessment_id + kind + checksum` | yes (upload idempotency) |
| `pages` | `document_id + page_number` | yes |
| every tenant collection | `organization_id + <owning id>` | no |

## Enumerations

```
document.kind        := question_paper | answer_sheet
document.classification := searchable | scanned | image
page.extraction_method  := text | ocr
mapping.mapping_type    := direct | semantic | spatial | unmatched | unanswered
mapping.review_status   := auto_accepted | needs_review | human_confirmed | human_corrected
job.status              := queued | running | succeeded | failed
```

## Relationships that carry meaning

- **`questions.parent_id`** — `11(a)` and `11(b)` are separate rows sharing a parent of
  `11`. `(i)`/`(ii)` nest one level deeper. Nesting is real hierarchy, not string prefixes.
- **`answers.is_continuation_of`** — links a continuation segment on a later page to the
  segment it continues. Both contribute regions to the same logical answer.
- **`*_regions` are one-to-many by design** — a question or answer spanning pages 3 and 4
  has two region rows. A single-bbox model would have made multi-page answers
  unrepresentable.
- **`mappings.question_id` and `answer_id` are both nullable** — a null answer means
  `unanswered`, a null question means `unmatched` (an extra answer). Both are real
  outcomes the UI must show, not error states.
- **`mappings.evidence`** — records which stage fired, the score breakdown, and the LLM
  verdict if any. This is what makes a low-confidence mapping reviewable rather than
  merely doubtful.

## Nullability worth noting

| Field | Null means |
|---|---|
| `answers.detected_label` | No explicit `11(a)`-style label was written; mapping must rely on spatial/semantic stages |
| `questions.max_marks` | Paper did not print marks for this question |
| `mappings.question_id` | Extra answer that maps to nothing |
| `mappings.answer_id` | Question was not answered |

## Transactions

The Unit of Work (`app/db/session.py`) is an identity map plus a dirty check. With
`MONGO_TRANSACTIONS=true` (replica set) the whole unit runs in one multi-document
transaction and a half-failed stage leaves nothing behind. On a standalone mongod there
is no transaction to join: `rollback()` can only drop unflushed writes, so services
flush late and every write is an idempotent upsert keyed by `_id`.

## Indexes

There is no schema to migrate; indexes are the only declaration. They are created by
`create_all()` on release (`make indexes`), never implicitly during request handling.
Unique: `(organization_id, email)` on `users`, `(document_id, page_number)` on `pages`,
and `(organization_id, assessment_id, kind, checksum)` on `documents` — the last is what
makes re-uploading an identical file idempotent.

## Coordinates

`bbox` is always `[x1, y1, x2, y2]`, normalised floats in `[0,1]`, origin top-left,
relative to the page's **original** dimensions. `pages.width/height/dpi` are stored so
any consumer can convert back to pixels. See
[03-coordinate-contract.md](03-coordinate-contract.md) — this convention is not
negotiable per-module.
