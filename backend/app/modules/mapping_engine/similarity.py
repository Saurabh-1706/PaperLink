"""Textual similarity signals for stage 4.

Keyword overlap and fuzzy ratio are computed first and cost nothing. Embeddings are
consulted only when the cheap signals leave a pair genuinely undecided, and the caller
must work without them.
"""
from __future__ import annotations

import math
import re

from rapidfuzz import fuzz

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
    "it", "of", "on", "or", "that", "the", "to", "was", "what", "when", "where", "which",
    "who", "why", "with", "explain", "define", "describe", "state", "give", "write",
    "answer", "question", "following", "briefly", "your", "you",
}

TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return [token for token in TOKEN.findall(text.lower()) if token not in STOPWORDS and len(token) > 2]


def keyword_overlap(question_text: str, answer_text: str) -> float:
    question_tokens = set(tokenize(question_text))
    answer_tokens = set(tokenize(answer_text))
    if not question_tokens or not answer_tokens:
        return 0.0
    intersection = question_tokens & answer_tokens
    return len(intersection) / math.sqrt(len(question_tokens) * len(answer_tokens))


def fuzzy_ratio(question_text: str, answer_text: str) -> float:
    if not question_text.strip() or not answer_text.strip():
        return 0.0
    return fuzz.token_set_ratio(question_text.lower(), answer_text.lower()) / 100.0


def semantic_score(question_text: str, answer_text: str) -> float:
    """Cheap deterministic blend. Short handwritten answers share little vocabulary with
    their question, so this is a contributing signal — never the decision."""
    overlap = keyword_overlap(question_text, answer_text)
    fuzzy = fuzzy_ratio(question_text, answer_text)
    return round(0.7 * overlap + 0.3 * fuzzy, 4)


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0
