// EXP-10 part 1: images and maths in question content. Pure schema fragments, no DB, no React.
//   math          true when the stem and options contain LaTeX between \( \) or \[ \]. Default absent = plain text,
//                 so old questions never change.
//   stem_assets   up to 3 asset ids (question_assets) shown under the stem.
//   option_assets aligned to `options`: an asset id or null per option. Permuted with the options by the shuffle.
// The ids are checked again in Postgres (trigger on question_versions): same pack, same tenant.
import { z } from "zod";

export const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_STEM_ASSETS = 3;
export const MAX_ASSETS_PER_QUESTION = 6;

const AssetId = z.string().regex(ASSET_ID_RE);

export const RichStemFields = {
  math: z.boolean().optional(),
  stem_assets: z.array(AssetId).max(MAX_STEM_ASSETS).optional(),
} as const;

export const RichOptionFields = {
  option_assets: z.array(AssetId.nullable()).max(10).optional(),
} as const;

/** Keys the candidate view and the licensed admin view may pass through (ids and a boolean only). */
export const RICH_VIEW_KEYS = ["math", "stem_assets", "option_assets"] as const;

/** At most MAX_ASSETS_PER_QUESTION distinct ids across the stem and the options; option_assets as long as options. */
export function checkRichRefs(
  val: { options?: readonly unknown[] | undefined; stem_assets?: readonly string[] | undefined; option_assets?: readonly (string | null)[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const oa = val.option_assets;
  if (oa !== undefined && val.options !== undefined && oa.length !== val.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["option_assets"], message: "option_assets must have one entry per option" });
  }
  const ids = new Set<string>([...(val.stem_assets ?? []), ...((oa ?? []).filter((x): x is string => x !== null))]);
  if (ids.size > MAX_ASSETS_PER_QUESTION) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stem_assets"], message: `at most ${MAX_ASSETS_PER_QUESTION} images per question` });
  }
}

// EXP-9 A1: Hindi overlay inside the versioned content (FUT-3 D9), MCQ only. Frozen with the version.
// `options` must be as long as the English options (checked by checkI18nHi); `rationale` is admin-only.
export const I18nHiSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  rationale: z.string().min(1).optional(),
}).strict();

export const RichI18nField = {
  i18n: z.object({ hi: I18nHiSchema }).strict().optional(),
} as const;

export function checkI18nHi(
  val: { options?: readonly unknown[] | undefined; i18n?: { hi: { options: readonly unknown[] } } | undefined },
  ctx: z.RefinementCtx,
): void {
  if (val.i18n !== undefined && val.options !== undefined && val.i18n.hi.options.length !== val.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["i18n", "hi", "options"], message: "i18n.hi.options must have one entry per option" });
  }
}

/** Candidate view of the overlay: question and options only. The Hindi rationale never leaves the server. */
export function i18nCandidateView(c: Record<string, unknown>): Record<string, unknown> {
  const hi = (c["i18n"] as { hi?: { question?: unknown; options?: unknown } } | undefined)?.hi;
  if (hi === undefined || hi === null || typeof hi !== "object") return {};
  return { i18n: { hi: { question: hi.question, options: hi.options } } };
}
