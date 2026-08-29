"""Question pipeline: IR-JSON in, structured questions out.

Independent module — it knows nothing about answers. Deterministic parsing first;
ambiguity routing (and only that) may reach a model, via `graphs/question_graph.py`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import settings
from app.modules.question_pipeline.labels import ParsedLabel, parent_of, parse_label, sort_key
from app.schemas.common import Region, union_all
from app.schemas.ir import IRBlock, IRDocument
from app.schemas.pipeline import ExtractedQuestion, QuestionPipelineResult

MARKS_PATTERNS = [
    re.compile(r"[\[\(]\s*(\d{1,3})\s*(?:marks?|m)\s*[\]\)]", re.IGNORECASE),
    re.compile(r"\b(\d{1,3})\s*marks?\b", re.IGNORECASE),
    re.compile(r"[\[\(]\s*(\d{1,3})\s*[\]\)]\s*$"),
]

OPTIONAL_PATTERNS = [
    re.compile(r"\battempt\s+any\b", re.IGNORECASE),
    re.compile(r"\banswer\s+any\b", re.IGNORECASE),
    re.compile(r"\beither\b.*\bor\b", re.IGNORECASE),
    re.compile(r"\bor\b\s*$", re.IGNORECASE),
    re.compile(r"\boptional\b", re.IGNORECASE),
]


@dataclass
class _Candidate:
    label: ParsedLabel
    page: int
    block: IRBlock
    position: int


def extract_questions(document: IRDocument) -> QuestionPipelineResult:
    ordered = document.ordered_blocks()
    candidates = _detect_numbering(ordered)
    if not candidates:
        return QuestionPipelineResult(
            questions=[], ambiguities=["no_numbering_detected"],
            orphan_block_ids=[block.block_id for _, block in ordered],
        )

    questions = _assign_bodies(ordered, candidates)
    questions = _apply_hierarchy(questions)
    orphans = _orphan_blocks(ordered, candidates, questions)
    ambiguities = detect_ambiguities(questions)
    return QuestionPipelineResult(
        questions=questions, ambiguities=ambiguities, orphan_block_ids=orphans
    )


# --------------------------------------------------------------------- stage 1: numbers
def _detect_numbering(ordered: list[tuple[int, IRBlock]]) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for position, (page, block) in enumerate(ordered):
        parsed = parse_label(block.text, allow_answer_prefix=False)
        if parsed is None:
            continue
        # A label with nothing after it, on a block that is otherwise long prose, is
        # more likely a citation than a question head; require a short prefix.
        if len(parsed.display) > 12:
            continue
        candidates.append(_Candidate(label=parsed, page=page, block=block, position=position))
    return candidates


# ---------------------------------------------------------------- stage 3: body assignment
def _assign_bodies(
    ordered: list[tuple[int, IRBlock]], candidates: list[_Candidate]
) -> list[ExtractedQuestion]:
    questions: list[ExtractedQuestion] = []
    for index, candidate in enumerate(candidates):
        start = candidate.position
        end = candidates[index + 1].position if index + 1 < len(candidates) else len(ordered)
        span = ordered[start:end]

        head_text = candidate.label.remainder
        body_parts = [head_text] if head_text else []
        block_ids = [candidate.block.block_id]
        for _, block in span[1:]:
            body_parts.append(block.text)
            block_ids.append(block.block_id)
        text = " ".join(part for part in body_parts if part).strip()

        regions = _regions_for(span)
        confidences = [block.confidence for _, block in span] or [1.0]
        questions.append(
            ExtractedQuestion(
                question_id=f"q-{candidate.label.normalized}-{index}",
                display_number=candidate.label.display.rstrip(" .:"),
                normalized_number=candidate.label.normalized,
                text=text,
                pages=sorted({page for page, _ in span}),
                regions=regions,
                order_index=index,
                optional=_is_optional(text),
                max_marks=_detect_marks(text),
                confidence=round(min(1.0, sum(confidences) / len(confidences)), 4),
                block_ids=block_ids,
            )
        )
    return questions


def _regions_for(span: list[tuple[int, IRBlock]]) -> list[Region]:
    """One region per page — a question crossing a page boundary gets a region on each."""
    by_page: dict[int, list] = {}
    for page, block in span:
        by_page.setdefault(page, []).append(block.bbox)
    return [Region(page=page, bbox=union_all(boxes)) for page, boxes in sorted(by_page.items())]


# ------------------------------------------------------------------- stage 2: hierarchy
def _apply_hierarchy(questions: list[ExtractedQuestion]) -> list[ExtractedQuestion]:
    """`11(a)` and `11(b)` are separate rows sharing a parent of `11`; `(i)` nests deeper.

    Bare `(a)` / `(i)` labels inherit the nearest preceding numeric stem, so a paper that
    prints `11.` then `(a)` on the next line still produces `11.a`.
    """
    out: list[ExtractedQuestion] = []
    stem_top: str | None = None
    stem_sub: str | None = None
    known = set()
    for question in questions:
        parts = question.normalized_number.split(".")
        if parts[0].isdigit():
            stem_top = parts[0]
            stem_sub = parts[1] if len(parts) > 1 else None
            normalized = question.normalized_number
        elif stem_top is not None:
            is_roman = all(char.isalpha() and char in "ivx" for char in parts[0]) and len(parts[0]) > 0
            if is_roman and stem_sub:
                normalized = f"{stem_top}.{stem_sub}.{parts[0]}"
            else:
                normalized = f"{stem_top}.{parts[0]}"
                stem_sub = parts[0]
        else:
            normalized = question.normalized_number
        while normalized in known:  # duplicate labels must not collide silently
            normalized = f"{normalized}'"
        known.add(normalized)
        parent = parent_of(normalized)
        out.append(
            question.model_copy(
                update={
                    "normalized_number": normalized,
                    "parent_number": parent,
                    "question_id": f"q-{normalized}",
                }
            )
        )
    return out


def _orphan_blocks(
    ordered: list[tuple[int, IRBlock]],
    candidates: list[_Candidate],
    questions: list[ExtractedQuestion],
) -> list[str]:
    if not candidates:
        return [block.block_id for _, block in ordered]
    first = candidates[0].position
    return [block.block_id for _, block in ordered[:first]]


# ------------------------------------------------------------ stage 4: ambiguity checks
def detect_ambiguities(questions: list[ExtractedQuestion]) -> list[str]:
    """Deterministic checks that decide whether a model is needed at all."""
    issues: list[str] = []
    tops = [
        int(question.normalized_number.split(".")[0])
        for question in questions
        if question.normalized_number.split(".")[0].isdigit()
    ]
    unique_tops = sorted(set(tops))
    if tops != sorted(tops):
        issues.append("non_monotonic_numbering")
    for previous, current in zip(unique_tops, unique_tops[1:]):
        if current - previous > 1:
            issues.append(f"gap_between_{previous}_and_{current}")
    for question in questions:
        if not question.text.strip():
            issues.append(f"empty_body:{question.normalized_number}")
        if question.confidence < settings.question_confidence_threshold:
            issues.append(f"low_confidence:{question.normalized_number}")
    return issues


# ----------------------------------------------------------------- stages 5 & 6: extras
def _is_optional(text: str) -> bool:
    return any(pattern.search(text) for pattern in OPTIONAL_PATTERNS)


def _detect_marks(text: str) -> float | None:
    for pattern in MARKS_PATTERNS:
        match = pattern.search(text)
        if match:
            return float(match.group(1))
    return None


def sort_questions(questions: list[ExtractedQuestion]) -> list[ExtractedQuestion]:
    return sorted(questions, key=lambda q: sort_key(q.normalized_number))
