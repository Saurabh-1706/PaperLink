"""Question-label parsing and normalisation.

Shared verbatim with the mapping engine so `11 a`, `11(a)` and `Q11a` collapse
identically on both sides — if they did not, matching would fail on whitespace.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

ROMAN_VALUES = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}

# Ordered by specificity: the first pattern that matches at the start of a line wins.
_TOP_LEVEL = r"(?:Q(?:ues(?:tion)?)?\s*\.?\s*)?(?P<num>\d{1,3})"
_SUB = r"(?:\s*[\(\[]?\s*(?P<sub>[a-hA-H])\s*[\)\].]?)"
# The opening bracket is optional: real papers print `(i)` and `i)` interchangeably,
# and a bare `ii)` heading a line is by far the commoner of the two.
_SUBSUB = r"(?:\s*[\(\[]?\s*(?P<subsub>[ivxIVX]{1,4})\s*[\)\].])"

PATTERNS: list[re.Pattern[str]] = [
    re.compile(rf"^\s*{_TOP_LEVEL}{_SUB}{_SUBSUB}\s*[\.\):]?\s*", re.IGNORECASE),
    re.compile(rf"^\s*{_TOP_LEVEL}{_SUB}\s*[\.\):]?\s+", re.IGNORECASE),
    re.compile(rf"^\s*{_TOP_LEVEL}\s*[\.\):]\s*", re.IGNORECASE),
    # "Q5 State ..." — the Q prefix carries the same weight as trailing punctuation.
    re.compile(r"^\s*Q(?:ues(?:tion)?)?\s*\.?\s*(?P<num>\d{1,3})\s*[\.\):]?\s+", re.IGNORECASE),
    re.compile(rf"^\s*{_TOP_LEVEL}\s*$", re.IGNORECASE),
    re.compile(r"^\s*[\(\[]\s*(?P<subsub>[ivx]{1,4})\s*[\)\].]\s*", re.IGNORECASE),
    # `a) i) ...` — one block carrying both levels. Without this the roman level is
    # swallowed into the body and `12.b.ii` never becomes a row of its own.
    re.compile(
        r"^\s*[\(\[]?\s*(?P<sub>[a-h])\s*[\)\].]\s*[\(\[]?\s*(?P<subsub>[ivx]{1,4})\s*[\)\].]\s+",
        re.IGNORECASE,
    ),
    re.compile(r"^\s*[\(\[]\s*(?P<sub>[a-h])\s*[\)\].]\s*", re.IGNORECASE),
    re.compile(r"^\s*(?P<sub>[a-h])\s*[\)\.]\s+", re.IGNORECASE),
    # Bare roman, no brackets: `ii) Write the ...`. Kept last so `i` is only read as a
    # roman numeral once every lettered reading has been ruled out.
    re.compile(r"^\s*(?P<subsub>[ivx]{1,4})\s*[\)\.]\s+", re.IGNORECASE),
]

# Answer sheets add "Ans" / "Answer" prefixes.
ANSWER_PREFIX = re.compile(r"^\s*(?:ans(?:wer)?)\s*\.?\s*[:\-]?\s*", re.IGNORECASE)


@dataclass(frozen=True)
class ParsedLabel:
    display: str            # verbatim slice from the text, e.g. "11 (a)"
    normalized: str         # canonical sortable form, e.g. "11.a"
    level: int              # 0 = top level, 1 = (a), 2 = (i)
    remainder: str          # the text after the label
    top: str | None
    sub: str | None
    subsub: str | None


def parse_label(text: str, allow_answer_prefix: bool = False) -> ParsedLabel | None:
    """Parse a leading question label. Returns None when the line does not start with one."""
    source = text
    offset = 0
    if allow_answer_prefix:
        prefix = ANSWER_PREFIX.match(source)
        if prefix:
            offset = prefix.end()
            source = source[offset:]

    for pattern in PATTERNS:
        match = pattern.match(source)
        if not match:
            continue
        groups = match.groupdict()
        top, sub, subsub = groups.get("num"), groups.get("sub"), groups.get("subsub")
        if not any((top, sub, subsub)):
            continue
        display = text[: offset + match.end()].strip()
        normalized = normalize_parts(top, sub, subsub)
        if not normalized:
            continue
        level = 0 if top and not sub and not subsub else (1 if sub and not subsub else 2)
        return ParsedLabel(
            display=display,
            normalized=normalized,
            level=level,
            remainder=source[match.end():].strip(),
            top=top,
            sub=(sub or "").lower() or None,
            subsub=(subsub or "").lower() or None,
        )
    return None


def normalize_parts(top: str | None, sub: str | None, subsub: str | None) -> str:
    parts: list[str] = []
    if top:
        parts.append(str(int(top)))
    if sub:
        parts.append(sub.lower())
    if subsub:
        parts.append(subsub.lower())
    return ".".join(parts)


# U7 — deduplicate normalised labels within a parent scope.
# When two sub-questions share the same label (e.g. two `ii)` under Q14.a), append
# `.2`, `.3` etc. to the second and subsequent occurrences so they are matchable.
def deduplicate_normalized_numbers(questions: list) -> list:
    """Mutate-free: returns a new list with disambiguated normalized_number values.
    Expects objects with .normalized_number and .parent_number attributes.
    """
    seen: dict[str, int] = {}
    out = []
    for question in questions:
        key = question.normalized_number
        count = seen.get(key, 0)
        if count == 0:
            seen[key] = 1
            out.append(question)
        else:
            seen[key] = count + 1
            new_num = f"{key}.{count + 1}"
            out.append(question.model_copy(update={
                "normalized_number": new_num,
                "question_id": f"q-{new_num}",
            }))
    return out


def normalize_label(text: str, allow_answer_prefix: bool = True) -> str | None:
    """Collapse any rendering of a label to its canonical form, or None."""
    parsed = parse_label(text, allow_answer_prefix=allow_answer_prefix)
    return parsed.normalized if parsed else None


def sort_key(normalized: str) -> tuple:
    """Sortable key for a normalized_number such as `11.a.ii`."""
    key: list[tuple[int, int | str]] = []
    for index, part in enumerate(normalized.split(".")):
        if part.isdigit():
            key.append((0, int(part)))
        elif index == 2 and all(char in ROMAN_VALUES for char in part):
            key.append((0, roman_to_int(part)))
        else:
            key.append((1, part))
    return tuple(key)


def roman_to_int(value: str) -> int:
    total, previous = 0, 0
    for char in reversed(value.lower()):
        current = ROMAN_VALUES.get(char, 0)
        total += current if current >= previous else -current
        previous = max(previous, current)
    return total


def parent_of(normalized: str) -> str | None:
    parts = normalized.split(".")
    return ".".join(parts[:-1]) if len(parts) > 1 else None


def extract_top_int(normalized: str) -> int | None:
    """Return the leading integer from a normalised label, e.g. '18.a' -> 18."""
    part = normalized.split(".")[0]
    return int(part) if part.isdigit() else None
