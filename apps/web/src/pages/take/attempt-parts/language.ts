// EXP-9 A4: Hindi overlay on the take page. The server sends content.i18n.hi = { question, options }
// with options in the SAME display order as English, so an answer index means the same in both languages.
import type { FrozenQuestionWire } from "@assessiq/candidate-ui";
import { STEM_FIELD } from "./shared.js";

export type Lang = "en" | "hi";

interface HiOverlay { question: string; options: string[] }

function hiOf(q: FrozenQuestionWire): HiOverlay | null {
  const c = q.content as { i18n?: { hi?: { question?: unknown; options?: unknown } } } | null;
  const hi = c?.i18n?.hi;
  if (hi === undefined || hi === null || typeof hi.question !== "string" || !Array.isArray(hi.options)) return null;
  return { question: hi.question, options: hi.options.filter((o): o is string => typeof o === "string") };
}

export const hasHindi = (q: FrozenQuestionWire): boolean => hiOf(q) !== null;

/** The question as shown: Hindi stem and options when chosen and present, else the English question. Never the rationale. */
export function localize(q: FrozenQuestionWire, lang: Lang): FrozenQuestionWire {
  const hi = lang === "hi" ? hiOf(q) : null;
  if (hi === null) return q;
  const c = q.content as Record<string, unknown>;
  const field = (STEM_FIELD as Record<string, string>)[q.type] ?? "question";
  const en = c["options"];
  const { i18n: _drop, ...rest } = c;
  void _drop;
  return {
    ...q,
    content: {
      ...rest,
      [field]: hi.question,
      ...(Array.isArray(en) && en.length === hi.options.length ? { options: hi.options } : {}),
    },
  };
}

let fontLoad: Promise<unknown> | null = null;
/** Self-hosted Noto Sans Devanagari (fontsource, bundled under our own origin); fetched only when Hindi is first chosen. */
export function loadHindiFont(): void {
  fontLoad ??= Promise.all([
    import("@fontsource/noto-sans-devanagari/devanagari-400.css"),
    import("@fontsource/noto-sans-devanagari/devanagari-600.css"),
  ]).catch(() => undefined);
}
