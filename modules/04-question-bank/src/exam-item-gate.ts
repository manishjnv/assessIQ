/**
 * EXP-7: pure similarity gate and mode helpers for the exam-item generator.
 *
 * No DB, no network, no AI call. Seeds (private exam items) are passed in as an argument by
 * the caller at run time; they are never stored in this repository.
 *
 * Similarity (deterministic, documented):
 *   1. lower-case, NFKC-normalise, split on anything that is not a letter, mark or digit
 *      (Unicode aware, so Hindi text works; combining marks stay inside the word);
 *   2. build the set of word 3-grams ("shingles"); a text of fewer than 3 words uses its words;
 *   3. similarity = |A and B| / |A or B| (Jaccard), a number from 0 to 1.
 *
 * Rules:
 *   A1 (new original item): reject when the similarity to ANY seed is at or above
 *      A1_MAX_SEED_SIMILARITY.
 *   A2 (light edit): the item must keep its source. Reject when the similarity to its own
 *      source is below A2_MIN_SOURCE_SIMILARITY (drifted too far) or at or above
 *      A2_MAX_SOURCE_SIMILARITY (unchanged copy). It is de-duplicated against the platform
 *      bank (never against its own source): reject at or above A2_MAX_BANK_SIMILARITY.
 */

export const A1_MAX_SEED_SIMILARITY = 0.35;
export const A2_MIN_SOURCE_SIMILARITY = 0.4;
export const A2_MAX_SOURCE_SIMILARITY = 0.97;
export const A2_MAX_BANK_SIMILARITY = 0.85;

export const EXAM_ITEM_MODES = ["a1", "a2"] as const;
export type ExamItemMode = (typeof EXAM_ITEM_MODES)[number];

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export function shingles(text: string, n = 3): Set<string> {
  const toks = tokenize(text);
  if (toks.length === 0) return new Set();
  if (toks.length < n) return new Set(toks);
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

/** Jaccard similarity of the shingle sets, 0 to 1. Two empty texts give 0. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** One text per item: stem, then options in order. Used for both sides of a comparison. */
export function itemText(item: { stem: string; options?: readonly string[] | undefined }): string {
  return [item.stem, ...(item.options ?? [])].join(" \n ");
}

export type GateReason =
  | "ok"
  | "too_close_to_seed"
  | "too_far_from_source"
  | "unchanged_copy"
  | "duplicate_in_bank"
  | "missing_source";

export interface GateResult {
  ok: boolean;
  reason: GateReason;
  /** Highest similarity that decided the result (seed, source or bank, by rule). */
  score: number;
  /** Index into the seeds / bank array of the closest entry; never the text itself. */
  closestIndex: number | null;
}

function maxSimilarity(text: string, others: readonly string[]): { score: number; index: number | null } {
  let score = 0;
  let index: number | null = null;
  others.forEach((o, i) => {
    const s = similarity(text, o);
    if (s > score) {
      score = s;
      index = i;
    }
  });
  return { score, index };
}

/** A1: reject an item that is too close to any seed. Empty seed list passes (caller decides if that is allowed). */
export function gateA1(itemTextValue: string, seeds: readonly string[]): GateResult {
  const { score, index } = maxSimilarity(itemTextValue, seeds);
  if (score >= A1_MAX_SEED_SIMILARITY) return { ok: false, reason: "too_close_to_seed", score, closestIndex: index };
  return { ok: true, reason: "ok", score, closestIndex: index };
}

/** A2: item must stay close to its source reference and must not duplicate the platform bank. */
export function gateA2(
  itemTextValue: string,
  sourceText: string | null | undefined,
  bank: readonly string[] = [],
): GateResult {
  if (sourceText === null || sourceText === undefined || sourceText.trim() === "") {
    return { ok: false, reason: "missing_source", score: 0, closestIndex: null };
  }
  const src = similarity(itemTextValue, sourceText);
  if (src >= A2_MAX_SOURCE_SIMILARITY) return { ok: false, reason: "unchanged_copy", score: src, closestIndex: null };
  if (src < A2_MIN_SOURCE_SIMILARITY) return { ok: false, reason: "too_far_from_source", score: src, closestIndex: null };
  const b = maxSimilarity(itemTextValue, bank);
  if (b.score >= A2_MAX_BANK_SIMILARITY) {
    return { ok: false, reason: "duplicate_in_bank", score: b.score, closestIndex: b.index };
  }
  return { ok: true, reason: "ok", score: src, closestIndex: null };
}

/**
 * Provenance written to `question_source` (migration 0194, no schema change needed):
 * A1 -> origin ai_original / rights original; A2 -> origin and rights derived_from_source with
 * the source reference kept in `source_ref`.
 */
export function provenanceFor(
  mode: ExamItemMode,
  sourceRef?: string | undefined,
): { origin: "ai_original" | "derived_from_source"; rightsStatus: "original" | "derived_from_source"; sourceRef: string | null } {
  if (mode === "a1") return { origin: "ai_original", rightsStatus: "original", sourceRef: null };
  if (sourceRef === undefined || sourceRef.trim() === "") throw new Error("A2 requires a source reference");
  return { origin: "derived_from_source", rightsStatus: "derived_from_source", sourceRef: sourceRef.trim().slice(0, 500) };
}
