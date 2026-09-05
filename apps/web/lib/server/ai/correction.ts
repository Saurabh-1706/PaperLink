/**
 * Pre-LLM OCR text correction. Port of backend/app/ai/ocr/correction.py.
 *
 * Two layers applied before any vision-LLM call:
 * 1. Artifact cleaning — regex substitutions for common OCR character confusions
 *    (0/O, l/1, rn/m, etc.) that are safe to fix without context.
 * 2. Domain guard — terms in DOMAIN_TERMS are never sent to the LLM for correction;
 *    they are masked out, the LLM corrects the rest, then they are restored. This
 *    prevents the model from "fixing" mitochondria, phosphodiester, etc.
 */

// ---------------------------------------------------------------------------
// 1. Artifact cleaning — order matters: more specific patterns first.
// ---------------------------------------------------------------------------
const ARTIFACT_RULES: Array<[RegExp, string]> = [
  // "rn" misread as "m": covers word-start (rnitochondria) and mid-word (cornrnunity)
  [/\brn(?=[a-z])/g, "m"],
  [/(?<=[a-z])rn(?=[a-z])/g, "m"],
  // digit-zero used as letter-O in all-alpha context
  [/(?<=[A-Za-z])0(?=[A-Za-z])/g, "o"],
  // lowercase-L used as digit-1 between digits
  [/(?<=\d)l(?=\d)/g, "1"],
  // stray pipe/broken-bar inside words
  [/(?<=[A-Za-z])\|(?=[A-Za-z])/g, "l"],
  // capital-I used as lowercase-l inside a word (e.g. "celI" -> "cell")
  [/(?<=[a-z])I(?=[a-z])/g, "l"],
  // double-space collapse
  [/ {2,}/g, " "],
  // trailing/leading whitespace per line
  [/^[ \t]+|[ \t]+$/gm, ""],
];

/** Apply safe, context-free OCR artifact substitutions. */
export function cleanArtifacts(text: string): string {
  let result = text;
  for (const [pattern, replacement] of ARTIFACT_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 2. Domain guard — biology / exam paper terms that must not be altered.
// ---------------------------------------------------------------------------
export const DOMAIN_TERMS: ReadonlySet<string> = new Set([
  // Biology
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
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace domain terms with placeholders. Returns [maskedText, restoreMap]. */
export function maskDomainTerms(text: string): [string, Record<string, string>] {
  const restore: Record<string, string> = {};
  let index = 0;
  let result = text;
  // Sort longest-first so "endoplasmic reticulum" matches before "endoplasmic".
  const termsByLengthDesc = [...DOMAIN_TERMS].sort((a, b) => b.length - a.length);
  for (const term of termsByLengthDesc) {
    const pattern = new RegExp(escapeRegExp(term), "gi");
    result = result.replace(pattern, (matched) => {
      const placeholder = `__DOMAIN_${index}__`;
      restore[placeholder] = matched;
      index += 1;
      return placeholder;
    });
    // Advance the global index past any replacements made for this term.
    const used = Object.keys(restore).map((k) => parseInt(k.match(/\d+/)?.[0] ?? "0", 10));
    index = used.length > 0 ? Math.max(...used) + 1 : 0;
  }
  return [result, restore];
}

/** Substitute placeholders back with their original domain terms (all occurrences). */
export function restoreDomainTerms(text: string, restore: Record<string, string>): string {
  let result = text;
  for (const [placeholder, original] of Object.entries(restore)) {
    result = result.split(placeholder).join(original);
  }
  return result;
}
