"""Pre-LLM OCR text correction.

Two layers applied before any vision-LLM call:

1. Artifact cleaning — regex substitutions for common OCR character confusions
   (0/O, l/1, rn/m, etc.) that are safe to fix without context.
2. Domain guard — terms in DOMAIN_TERMS are never sent to the LLM for correction;
   they are masked out, the LLM corrects the rest, then they are restored.
   This prevents the model from "fixing" mitochondria, phosphodiester, etc.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 1. Artifact cleaning — order matters: more specific patterns first.
# ---------------------------------------------------------------------------

_ARTIFACT_RULES: list[tuple[re.Pattern[str], str]] = [
    # "rn" misread as "m": covers word-start (rnitochondria) and mid-word (cornrnunity)
    (re.compile(r"\brn(?=[a-z])"), "m"),
    (re.compile(r"(?<=[a-z])rn(?=[a-z])"), "m"),
    # digit-zero used as letter-O in all-alpha context
    (re.compile(r"(?<=[A-Za-z])0(?=[A-Za-z])"), "o"),
    # lowercase-L used as digit-1 between digits
    (re.compile(r"(?<=\d)l(?=\d)"), "1"),
    # stray pipe/broken-bar inside words
    (re.compile(r"(?<=[A-Za-z])\|(?=[A-Za-z])"), "l"),
    # capital-I used as lowercase-l inside a word (e.g. "celI" -> "cell")
    (re.compile(r"(?<=[a-z])I(?=[a-z])"), "l"),
    # double-space collapse
    (re.compile(r"  +"), " "),
    # trailing/leading whitespace per line
    (re.compile(r"(?m)^[ \t]+|[ \t]+$"), ""),
]


def clean_artifacts(text: str) -> str:
    """Apply safe, context-free OCR artifact substitutions."""
    for pattern, replacement in _ARTIFACT_RULES:
        text = pattern.sub(replacement, text)
    return text


# ---------------------------------------------------------------------------
# 2. Domain guard — biology / exam paper terms that must not be altered.
# ---------------------------------------------------------------------------

DOMAIN_TERMS: frozenset[str] = frozenset(
    {
        # Biology
        "mitochondria", "mitochondrial", "mitochondrion",
        "photosynthesis", "photosynthetic",
        "endoplasmic", "reticulum",
        "phosphodiester", "polynucleotide", "nucleotide", "nucleotides",
        "deoxyribose", "ribose", "adenine", "thymine", "guanine", "cytosine", "uracil",
        "humification", "mineralisation", "mineralization",
        "decomposition", "fragmentation", "leaching", "catabolism",
        "coelacanth",
        "foeticide", "foetus", "foetal",
        "mtp",
        "trimester",
        "restriction", "endonuclease",
        "pvu",
        "rrna", "mrna", "trna", "snrna",
        "atp", "adp", "amp", "nadh", "nadph", "fadh",
        "dna", "rna", "pcr",
        "allele", "alleles", "homozygous", "heterozygous",
        "phenotype", "genotype",
        "meiosis", "mitosis",
        "chromosome", "chromosomes", "chromatid",
        "plasmid", "plasmids",
        "prokaryote", "eukaryote", "prokaryotic", "eukaryotic",
        "glycolysis", "krebs", "pyruvate",
        "stomata", "stoma", "chloroplast", "chlorophyll",
        "xylem", "phloem",
        "osmosis", "diffusion", "plasmolysis",
        "assertion", "reason",
    }
)

_PLACEHOLDER = "__DOMAIN_{index}__"
_PLACEHOLDER_RE = re.compile(r"__DOMAIN_(\d+)__")


def mask_domain_terms(text: str) -> tuple[str, dict[str, str]]:
    """Replace domain terms with placeholders. Returns (masked_text, restore_map)."""
    restore: dict[str, str] = {}
    index = 0
    # Sort longest-first so "endoplasmic reticulum" matches before "endoplasmic"
    for term in sorted(DOMAIN_TERMS, key=len, reverse=True):
        pattern = re.compile(re.escape(term), re.IGNORECASE)

        def _replacer(m: re.Match, _idx: list[int] = [index]) -> str:  # noqa: B006
            placeholder = _PLACEHOLDER.format(index=_idx[0])
            restore[placeholder] = m.group(0)
            _idx[0] += 1
            return placeholder

        text = pattern.sub(_replacer, text)
        # Advance global index past any replacements made for this term
        index = max((int(k.split("_")[3]) + 1) for k in restore) if restore else 0

    return text, restore


def restore_domain_terms(text: str, restore: dict[str, str]) -> str:
    """Substitute placeholders back with their original domain terms."""
    for placeholder, original in restore.items():
        text = text.replace(placeholder, original)
    return text


def preprocess_ocr_line(line: str) -> str:
    """Artifact-clean a single OCR line (no masking — use for display/logging)."""
    return clean_artifacts(line)
