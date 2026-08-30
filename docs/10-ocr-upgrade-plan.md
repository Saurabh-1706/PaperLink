# OCR Upgrade Plan — Handwriting Path

**Date:** 2026-08-30
**Status:** Phases 1-5 complete and measured (2026-08-30). Phase 6 not started.
Phase 6 not started. The unticked boxes below are measurement runs, not code: they
need real scanned papers with committed transcriptions, a contended box to show the
thread-pinning delta, and a GPU to make Phase 5 worth enabling.
**Defaults:** every new behaviour ships off or telemetry-only — `OCR_FLATTEN_BACKGROUND=false`, `OCR_ADAPTIVE_THRESHOLD=false`, `LINE_SCRIPT_MODE=telemetry`, `LINE_RECOGNIZER=none`
**Scope:** `app/modules/extraction/`, `app/ai/ocr/`, `app/workers/`
**Does not change:** `docs/03-coordinate-contract.md`, ADR-001, any schema in `app/schemas/`

Goal: raise handwriting transcription accuracy on answer sheets **and** reduce
end-to-end latency. On the current CPU deployment these are two different projects —
the plan sequences them so each is measured on its own and reverted by a config flag.

---

## Baseline — what already exists

The upgrade proposal this plan responds to assumed a `OCR → LLM → output` pipeline
where every page reaches the LLM. That is not what the code does. Four of the ten
proposed optimisations are already shipped, which changes what is left to win.

| Proposed optimisation | Status | Where |
|---|---|---|
| Confidence-based routing | Done | `answer_pipeline/pipeline.py:42`, `graphs/answer_graph.py:26` |
| LLM sees only low-confidence text | Done — one call per page, flagged answers only | `answer_pipeline/vision.py:68` |
| Cheap correction before the LLM | Done — artifact rules + domain-term masking | `ai/ocr/correction.py` |
| Resolution tuning | Done — 1800px handwriting / 1600px print, from sweep | `extraction/pipeline.py:124`, `res_sweep.py` |
| Skip OCR where possible | Done — searchable pages take the native-text path | `extraction/pipeline.py:58` |
| Background removal | **Missing** — contrast is global `autocontrast(cutoff=1)` | `extraction/preprocess.py:36` |
| Region classification | **Missing** — page treated as one homogeneous surface | `extraction/pipeline.py:60` |
| Handwriting recogniser | **Missing** — vision LLM is the only repair path | `ai/ocr/rapid.py:11` |
| Batching | Partial — pages run 4-wide; nothing batched within a page | `extraction/pipeline.py:79` |

**Consequence for the estimate.** The "100 pages → 15 pages of LLM" saving is already
taken. Remaining latency sits in OCR itself, in per-worker model warm-up, and in thread
oversubscription between the page pool and ONNXRuntime — not in LLM fan-out.

---

## Target architecture

```
01  Render pages                         documents/pdf.py           (unchanged)
02  Deskew + denoise + resize            preprocess.py              (unchanged)
03  Illumination flattening              preprocess.py              NEW
04  Text detection                       RapidOCR DB detector       (unchanged, sole source of geometry)
05  Line-script classifier               extraction/pipeline.py     NEW
06  Recognition, routed by 05
      printed      → RapidOCR recogniser                            (unchanged)
      handwritten  → TrOCR, batched line crops                      NEW, flag-gated
      non-text     → skipped, block kept and flagged
07  Merge lines, invert transforms, normalise bbox   ir.py          (unchanged)
08  Segment answers, flag low confidence  answer_pipeline/          (unchanged)
09  Vision LLM on flagged answers only    vision.py                 (unchanged)
```

Stages 03, 05 and 06 are the whole change. Stages 08–09 are the existing confidence
routing and are untouched.

---

## Phase 1 — Instrument before changing anything

**Why first.** No accuracy delta can be claimed without a fixed labelled set. Every
later phase reports against the same three numbers.

- [x] Freeze the Biology papers currently used ad hoc into `tests/eval/fixtures/` with
      ground-truth transcriptions for the handwritten answer sheet
- [x] Add character error rate (CER) to `app/ai/evaluators/metrics.py`
- [x] Make `pytest tests/eval` print, per run: **CER**, **count of
      `low_confidence_answer_ids`**, **wall time per stage**
- [x] Fold the ad-hoc probes (`timing_probe.py`, `res_sweep.py`, `ocr_quality_probe.py`)
      into that harness or delete them — they are untracked scratch files today

**Exit criterion.** `pytest tests/eval` prints the three numbers reproducibly on the
frozen fixtures, twice in a row, with wall time varying under 10%.

**Touches:** `tests/eval/`, `app/ai/evaluators/metrics.py`

---

## Phase 2 — Thread pinning and worker warm-up

**Why second.** Pure configuration, zero accuracy risk. It moves the baseline that
every later phase is measured against, so it must land before Phase 3 is timed.

Three independent problems:

1. **Oversubscription.** `ThreadPoolExecutor(max_workers=min(4, len(renders)))` in
   `extraction/pipeline.py:79` × Celery `--concurrency=4` × ONNXRuntime's own intra-op
   pool. On an 8-core box that is dozens of threads contending for the same cores, and
   it presents as model slowness.
2. **Cold engine per worker.** The singleton in `ai/ocr/factory.py:8` is process-local
   and Celery prefork gives four processes. The first task each worker handles pays the
   full ONNX session load, inside a user's request.
3. **Redundant re-encoding.** `vision.py:51` decodes PNG and re-encodes JPEG on every
   vision call, for an image that is already persisted.

- [x] Set `OMP_NUM_THREADS=2` and `ONNXRUNTIME_INTRA_OP_NUM_THREADS=2` on the worker
      service in `docker-compose.dev.yml`
- [x] Load the OCR engine in a `worker_process_init` signal in `workers/celery_app.py`
- [x] Persist the vision-ready JPEG alongside the page image instead of deriving it
      per call
- [x] Re-run the Phase 1 harness and record the new baseline — measured at 3-8%, not 20-40%

### Measured result — 2026-08-30, 8-core box

Single-process timing shows nothing: run-to-run variance (5.6 s) swamps the difference.
That is expected — one process has one page pool, and the oversubscription needs four.
Simulating `--concurrency=4` with four concurrent processes, each warm and running two
extractions:

| Config | Round 1 | Round 2 | Per-worker warm time |
|---|---|---|---|
| unpinned | 251.4 s | 228.1 s | 131.0 / 132.1 / 132.0 / 132.4 · 121.7 / 128.7 / 132.9 / 130.4 |
| pinned (OMP=2, ORT=2) | 239.6 s | 225.5 s | 119.5 / 123.6 / 127.0 / 127.1 · 112.6 / 117.8 / 117.9 / 118.2 |

**Roughly 3–8%, not the 20–40% this plan predicted.** The direction is consistent —
every one of the eight pinned workers beat every unpinned worker in its round — so the
setting stays. But the prediction was wrong and the honest number is single digits.
ONNXRuntime's own defaults were evidently already close to sane on this box; the
plan assumed a naive thread explosion that does not occur.

Keep the expectation calibrated: this is a small, repeatable win, not the headline.

**Exit criterion.** Wall time down measurably with CER unchanged. Expect 20–40% on an
oversubscribed box; if the number is flat, the box was not contended and that is a
valid result to record.

**Touches:** `docker-compose.dev.yml`, `workers/celery_app.py`, `answer_pipeline/vision.py`

---

## Phase 3 — Illumination flattening

**The problem.** `ImageOps.autocontrast(image, cutoff=1)` is a single global histogram
remap. On a flat scan it is fine. On a phone photo with one corner in shadow it must
satisfy both halves at once and serves neither — OCR confidence collapses, every line
on the page gets flagged, and the vision LLM is called for all of them. That is where
latency actually goes.

**The fix.** Estimate the page background with a morphological opening and divide the
image by it. Paper colour, shadow gradient and vignette all live in that estimate and
all disappear together. No new dependency: `PIL.ImageFilter.MaxFilter` / `MinFilter`
plus numpy, both already present.

```python
# app/modules/extraction/preprocess.py — after denoise, before contrast

def flatten_illumination(image: Image.Image, radius: int = 15) -> Image.Image:
    """Divide out the paper. Local where autocontrast is global."""
    import numpy as np

    background = image.filter(ImageFilter.MinFilter(radius)) \
                      .filter(ImageFilter.MaxFilter(radius))

    src = np.asarray(image, dtype=np.float32)
    bg = np.asarray(background, dtype=np.float32)
    np.maximum(bg, 1.0, out=bg)                    # no divide-by-zero

    flat = np.clip(src / bg * 255.0, 0, 255)
    return Image.fromarray(flat.astype("uint8"))
```

Wired in as a recorded step, so provenance stays visible in logs like every other step
in that file:

```python
if settings.ocr_flatten_background:
    image = flatten_illumination(image)
    chain.record("flatten", Transform.identity())
```

**Coordinate contract.** Flattening moves no pixels. It records
`Transform.identity()` and `docs/03-coordinate-contract.md` is unaffected.

- [x] Add `flatten_illumination` + `OCR_FLATTEN_BACKGROUND` (default `false`)
- [x] A/B on the Phase 1 fixtures: flagged-line count, CER, wall time
- [x] Enable by default only if flagged-line count drops without CER regressing — measured, and the answer was no; flag stays off

**Do not hard-binarise in this phase.** Adaptive thresholding is the risky half of the
original proposal: RapidOCR's recogniser is trained on natural grayscale crops, and
faint pencil is exactly the stroke class a threshold erases. If flattening proves
insufficient, add thresholding as a *separate* later flag with its own A/B.

**CLAHE.** Genuinely better than `autocontrast` for low-contrast scans, but `cv2` is a
~60 MB dependency not currently carried. Per the lazy-import rule in `CLAUDE.md`, add
`opencv-python-headless` only after flattening has been measured and found
insufficient, and keep the import inside the function.

### Measured result — 2026-08-30, `data/Biology-1-5.pdf`, RapidOCR, warm engine

| Config | Wall | Lines | Chars | Flagged | Mean conf |
|---|---|---|---|---|---|
| baseline (`autocontrast`) | 17.02 s | 63 | 1341 | 46 | 0.4806 |
| flatten | 16.89 s | 57 | 1262 | 41 | 0.4908 |
| flatten + threshold | 16.25 s | 50 | 1000 | 29 | 0.5137 |
| baseline again (drift check) | 15.24 s | 63 | 1341 | 46 | 0.4806 |

**Decision: leave `OCR_FLATTEN_BACKGROUND=false`.** The flag stays in the codebase for
shadowed phone-photo input, but it does not pay on this scan.

Three things the numbers say, none of them the hoped-for result:

1. **No latency effect.** Run-to-run drift on the *same* config was 1.78 s — larger
   than any gap between configs. An earlier run appeared to show flattening saving
   11.8 s; that was entirely the ONNX session load landing on whichever config ran
   first. Warm the engine before believing any OCR timing.
2. **Flattening costs content.** Characters recognised fell 1341 → 1262 (−6%), and
   with thresholding 1341 → 1000 (−25%). This scan carries no illumination gradient to
   remove, so the division only erodes strokes.
3. **The confidence rise is survivorship, not improvement.** Mean confidence went up
   (0.4806 → 0.5137) precisely *because* the hardest lines stopped being detected. A
   flagged-line count read on its own would have called this a win; it is not one.
   Any future A/B must report line and character counts beside the flag count.

**What the run did establish** is the case for Phase 5. Mean OCR confidence on this
handwriting is 0.48 with 46 of 63 lines flagged, and the recognised text is largely
noise (`&ecerdunzereyabeaiesaga`). Preprocessing is not the bottleneck on this
document — the print-trained recogniser is.

**Exit criterion.** Documented A/B on the frozen fixtures, and a decision recorded for
the flag's default.

**Touches:** `extraction/preprocess.py`, `core/config.py`, `extraction/pipeline.py:124`

---

## Phase 4 — Deterministic line-script classifier

**Why not a layout model first.** `CLAUDE.md` says deterministic Python first and
keyword overlap before embeddings; the same instinct applies. DocLayout-YOLO or
PP-StructureV3 would work and each adds a model download, a dependency, and 0.2–0.5 s
per page of CPU inference *before* any OCR runs. Most of the routing signal is already
in hand inside `group_ocr_words_into_lines`:

| Signal | Print | Handwriting |
|---|---|---|
| Recogniser confidence | high | systematically lower (print-trained model) |
| Baseline jitter (σ of `y2` across a row) | ≈ 0 | visibly nonzero |
| Height variance within a line | one x-height | scattered |
| Width-per-character regularity | tight cluster | scattered |

This is a pure function over `list[tuple[BBox, str, float]]` — no DB, no network, no
model, testable exactly as the module rules require.

- [x] Implement the score and threshold it into `printed` / `handwritten` / `uncertain`
- [x] Add the classification to `IRBlock` in `app/schemas/ir.py`
- [x] **Ship as telemetry only** — log the classification, change no routing behaviour
- [x] Measure the confusion rate against the fixtures before anything depends on it — done; found and fixed two calibration bugs, see below

**Escalation rule.** Buy the layout model only if the measured confusion rate is too
high, with that number in hand to justify it.

### Measured result — 2026-08-30

Two classes, both with genuine ground truth. Handwriting is page 4 of
`data/Biology-1-5.pdf`, transcribed by eye into `SCANNED_GROUND_TRUTH`. Print needed no
transcription: `data/question-paper.pdf` is a searchable PDF, so its own embedded text
layer is ground truth — rasterising it and forcing the OCR path gives a printed control
for free.

| Class | Lines | CER | WER | Mean conf | Flagged | Classifier correct |
|---|---|---|---|---|---|---|
| Handwriting (Biology p4) | 14 | **0.459** | 0.875 | 0.462 | 10/14 | 12/13 (92.3%) |
| Print (question paper p1) | 42 | **0.082** | 0.190 | 0.817 | 1/42 | 39/41 (95.1%) |

Score separation is wide: printed lines run 0.02–0.39, handwritten 0.16–0.98.

**This run found two bugs in the classifier**, both invisible on synthetic fixtures:

1. **Every printed line came back `UNCERTAIN`** (42 of 42). RapidOCR's detector returns
   one box per *line*, not one per word, so almost every run held a single fragment and
   the `MIN_FRAGMENTS_FOR_GEOMETRY` guard declined before scoring.
2. **The weighted sum zeroed unavailable signals**, which biases toward PRINTED. A
   single-box handwritten line scored ~0.44 — under the threshold — so it would have
   been routed to the printed branch. The score is now a weighted *average over the
   signals that are available*.

After the fix, print is 39/41 and handwriting 12/13. The two printed lines misread as
handwritten are both low-confidence; `should_replace` still guards the consequence.

**Interpretation.** CER 0.459 on handwriting is the number the whole plan exists for:
nearly half of every handwritten character is wrong, against 0.082 on print from the
same engine on the same page geometry. Preprocessing does not close a gap that size —
the recogniser does. This is the evidence for Phase 5.

**Exit criterion.** Confusion rate reported on the fixtures; no behaviour change merged.

**Touches:** `extraction/pipeline.py`, `schemas/ir.py`

---

## Phase 5 — TrOCR behind `LineRecognizer`, default off

### Why it fits the architecture

ADR-001 says coordinates never come from a model. TrOCR is a pure recogniser: crop in,
string out — it never sees a page and cannot produce a coordinate. It is a stricter
citizen than the vision LLM used today, which does see the full page image.

It does **not** fit the `OCREngine` ABC, which is `run(image_bytes) -> list[OCRWord]`
(page in, boxes out). It needs a second, narrower interface:

```python
# app/ai/ocr/recognizer.py

@dataclass(frozen=True)
class RecognizedLine:
    text: str
    confidence: float          # exp(mean token logprob)

class LineRecognizer(ABC):
    name = "abstract"

    @abstractmethod
    def read(self, crops: list[bytes]) -> list[RecognizedLine]:
        """Batched by contract — a one-at-a-time recogniser is a latency bug."""
```

Batching lives in the signature rather than in caller discipline.

### Confidence is mandatory, not optional

Every downstream stage — `low_confidence` flags, answer segmentation, the vision
trigger — is driven by a float in `[0,1]`. `generate()` returns only token ids by
default. Pass `output_scores=True, return_dict_in_generate=True` and reduce the
sequence to a scalar. Without it, TrOCR lines enter the IR with a fabricated confidence
and bypass every safety net in the pipeline.

### Anti-hallucination guards (mandatory)

TrOCR's decoder is a language model. Shown a diagram, a tick mark or a smudge it does
not return empty — it returns fluent, confident, invented English.

- [x] Route only lines that Phase 4 calls handwritten **and** whose detector confidence
      is below threshold
- [x] Never overwrite a line whose detector confidence is already high
- [x] Reject output whose length ratio against the RapidOCR text is implausible

`trocr-base-handwritten` is IAM-trained and English-only. It has no Devanagari; mixed
or non-Latin script papers must continue down the vision-LLM path.

### Latency reality

Autoregressive decode on CPU (`rapidocr-onnxruntime`, no torch in `requirements.txt`,
4 prefork workers) is roughly 0.4–1.2 s per line for `trocr-base-handwritten`.

| Path | Handwriting quality | Added latency, 4-page sheet | Verdict |
|---|---|---|---|
| Today — vision LLM per page | good, full-page context | ~8–20 s | baseline |
| TrOCR base, CPU, per line | good on clean cursive | +16–48 s | slower than baseline |
| TrOCR small, ONNX INT8, batched, CPU | fair | +5–14 s | marginal |
| TrOCR base, GPU, batch 8–16 | good | +1–3 s | clear win |
| Phases 3–4 alone, no TrOCR | fewer lines need repair at all | −2 to −8 s | win, no new model |

Read the last two rows together: flattening and routing reduce latency *because* they
shrink `low_confidence_answer_ids`, removing vision calls. TrOCR only reduces latency
if it removes more vision calls than it costs in decode time — on CPU it does not.

**On 8-bit quantization.** `BitsAndBytesConfig(load_in_8bit=True)` in the TrOCR docs is
a CUDA kernel with no CPU implementation. On these workers it is not a 10–30% saving;
it is an import error or a silent fallback. The CPU equivalent is Phase 6.

- [x] `app/ai/ocr/recognizer.py` — the ABC above
- [x] `app/ai/ocr/trocr.py` — adapter, lazy import, batched crops, logprob confidence
- [x] Selection via `LINE_RECOGNIZER` config, exactly as `OCR_ENGINE` works today
      (ADR-004)
- [x] Default off; enabled only on a GPU deployment — verified on CPU: CER 0.459 -> 0.274

### Measured result — 2026-08-30, `trocr-small-handwritten`, CPU

Run through the real routing path (`LINE_SCRIPT_MODE=route`,
`LINE_RECOGNIZER=trocr`) over Biology page 4, the page with a committed transcription:

| Config | CER | WER | Lines replaced |
|---|---|---|---|
| RapidOCR only | 0.459 | 0.875 | 0 |
| + TrOCR (small) | **0.274** | **0.573** | 10 of 14 |

**A 40% relative CER reduction, from the *small* model, on CPU.** The guards did their
job: 10 of 14 lines were replaced, the rest declined.

Latency, measured in isolation (batch_size=8, warm):

    model load     48.6 s, once per process
    decode         13.05 s for 14 lines -> 0.93 s/line

That lands inside the 0.4–1.2 s/line the plan predicted, so the latency estimate was
right even though the Phase 2 one was not. A five-page sheet at ~60 handwritten lines
is therefore roughly a minute of added decode on CPU — which is why the flag stays off
there, and why the warm-up handler matters if it is ever switched on.

**Extra dependencies.** `torch` and `transformers` are required, and on this
transformers version `trocr-small-handwritten` also needs `sentencepiece` (without it
the tokenizer is misread as a tiktoken file and load fails). None are in
`requirements.txt` by design — installing them is part of enabling the flag.

**Exit criterion.** CER improvement on handwritten fixtures with the guards active, and
a recorded latency cost. Merged disabled on CPU.

**Touches:** `ai/ocr/recognizer.py` *(new)*, `ai/ocr/trocr.py` *(new)*,
`ai/ocr/factory.py`, `core/config.py`

---

## Phase 6 — ONNX INT8 export *(optional, not started)*

Only if a GPU is genuinely unavailable and TrOCR is still wanted. Export encoder and
decoder through Optimum, apply dynamic INT8, and keep onnxruntime as the single
inference runtime rather than adding torch to the image. Expect fair-not-good quality;
verify against fixture CER before believing it.

---

## Configuration added

| Setting | Default | Phase |
|---|---|---|
| `OCR_FLATTEN_BACKGROUND` | `false` | 3 |
| `OCR_ADAPTIVE_THRESHOLD` | `false` | 3, later |
| `LINE_RECOGNIZER` | `none` | 5 |
| `TROCR_MODEL` | `microsoft/trocr-base-handwritten` | 5 |
| `TROCR_BATCH_SIZE` | `8` | 5 |
| `OMP_NUM_THREADS` (env, worker) | `2` | 2 |

---

## Expected outcome

| Configuration | Handwriting CER | Vision calls / sheet | Wall time |
|---|---|---|---|
| Today | baseline | 1 per page with flagged answers | baseline |
| + Phase 2 | unchanged | unchanged | −20 to −40% |
| + Phase 3 | −3 to −10% | fewer flagged lines | further down |
| + Phase 4 (telemetry only) | unchanged | unchanged | ≈ flat |
| + Phase 5, CPU | better on cursive | fewer | up, substantially |
| + Phase 5, GPU batched | best | fewest | near flat |

**Summary.** On current hardware the accuracy upgrade and the latency upgrade are
separate projects. Phases 2–4 give both at once and should ship regardless. Phase 5
buys accuracy and spends latency, and that trade only inverts on a GPU — build it
behind the flag now so the decision becomes a deployment choice rather than a rewrite.

---

## Risks

| Risk | Mitigation |
|---|---|
| Thresholding erases faint pencil | Flattening ships alone; thresholding is a separate flag with its own A/B |
| TrOCR hallucinates on non-text crops | Three guards in Phase 5; never overwrite a high-confidence line |
| TrOCR confidence fabricated → bypasses every flag | `output_scores=True` is a merge blocker, not a nicety |
| Non-Latin script papers | TrOCR is IAM/English-only; those pages stay on the vision path |
| Phase 4 misroutes print to TrOCR | Ships as telemetry first; routing is a separate merge |
| Accuracy claims without evidence | Phase 1 gates every later phase |

---

## Open questions

1. **Is a GPU worker in scope for this deployment?** Decides whether Phase 5 ships
   enabled or dormant.
2. **Are any answer sheets non-English?** A Devanagari or mixed-script paper needs a
   different checkpoint; the vision LLM handles those better today.
3. **What is the latency budget per submission?** Every trade above reads differently
   at a 10 s target than at a 90 s one.
4. **Scans or phone photos?** Flattening pays far more on the latter, and that ratio
   should drive how much effort Phase 3 gets.

---

## Reference

- Report version of this plan (same content, presentation format):
  https://claude.ai/code/artifact/19beb110-af75-4e26-9b52-321fd8c723f6
- TrOCR model card: https://huggingface.co/docs/transformers/en/model_doc/trocr
- `Breta01/handwriting-ocr` — 2017 TF CNN+CTC project. The model is superseded by
  TrOCR; the reusable idea is its page → line → word segmentation with normalisation
  before recognition, which this pipeline already has via the DB detector plus
  `group_ocr_words_into_lines`. Take the structure, not the weights.
