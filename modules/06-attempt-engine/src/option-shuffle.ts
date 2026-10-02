/**
 * Per-student MCQ option shuffle — pure helpers (no DB, no I/O).
 *
 * MODEL. `attempt_questions.option_order` (migration 0119) is a permutation
 * `order` with `order[displayPosition] = originalIndex`; NULL = original order.
 *   - The candidate only ever sees and sends DISPLAY positions.
 *   - Everything stored (attempt_answers.answer.selected), scored (09-scoring),
 *     reviewed (admin) and exported stays in ORIGINAL index space.
 * So the server translates at exactly two seams: save (display -> original) and
 * the candidate's own read (original -> display). `order` never leaves the server.
 *
 * FAIL-SAFE. Anything unexpected means "do not translate": an unusable order is
 * treated as NULL on BOTH seams (see usableOrder), and an invalid / out-of-range /
 * non-integer answer is passed through unchanged — exactly what the server did
 * before the shuffle existed (it stores the answer as sent; scoring never credits
 * it). A translation can therefore never turn an invalid answer into a valid one.
 */

import type { AttemptAnswer, FrozenQuestion } from "./types.js";

/** content.options is 2-8 strings (McqContentSchema); anything else is not shuffled. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
/** multi_select allows up to 10 options; startAttempt passes this as the cap (MCQ content is capped at 8 by its schema). */
export const MAX_SHUFFLE_OPTIONS = 10;

// ---------------------------------------------------------------------------
// 1. Which MCQs may be shuffled — options that refer to each other must not be
// ---------------------------------------------------------------------------
//
// An option is "referential" when its meaning depends on where its siblings are
// shown: "All of the above", "Both A and B", "Only B", "Option C", "1 and 3 only",
// "A. Paris" (its own label), ... When in doubt it is flagged: a false positive
// only means that question keeps its authored order, a false negative would
// scramble the question's meaning. Plain numeric / prose options ("12", "3.5",
// "2/3", "Rotate the API key every 90 days") are NOT flagged.

const REFERENTIAL: readonly RegExp[] = [
  // collective words that only make sense relative to the other options
  /\b(?:both|neither|either|none|nor)\b/i,
  // "All of the above", "Any of these", "Each option", "One of them", "All the rest"
  /\b(?:all|any|each|every|one|some|two|three|only)\s+(?:of\s+)?(?:the\s+)?(?:above|below|these|those|them|preceding|previous|foregoing|options?|choices?|answers?|statements?|alternatives?|others?|rest|remaining)\b/i,
  // "All are correct", "All true"
  /\ball\s+(?:(?:are|is|were)\s+)?(?:correct|true|false|incorrect|right|wrong)\b/i,
  // "Same as above", "see below" — but not a comparison with a number ("above 50", "below $5")
  /\b(?:above|below)\b(?!\s*[\d₹$€£+-])/i,
  // "the preceding", "the former", "the latter", "the previous one"
  /\b(?:preceding|foregoing|aforementioned|former|latter)\b|\bthe\s+previous\b/i,
  // "Option C", "choice (b)", "Statements 1 and 2", "Answer iv"
  /\b(?:options?|choices?|answers?|statements?|alternatives?)\s*(?:[(\[]\s*)?(?:[a-h]|[ivx]{1,4}|[1-9])\s*[)\]]?(?![a-z0-9])/i,
  // "the first option", "last choice", "the other answer", "previous option"
  /\b(?:first|second|third|fourth|fifth|last|next|previous|preceding|following|prior|other)\s+(?:option|choice|answer|statement|alternative)s?\b/i,
  // "first and second", "2nd and 4th", "the first two"
  /\b(?:first|second|third|fourth|fifth|\dst|\dnd|\drd|\dth)\s*(?:,|&|and|or)\s*(?:first|second|third|fourth|fifth|last|\dst|\dnd|\drd|\dth)\b|\b(?:first|last)\s+(?:two|three|four)\b/i,
  // "except B", "Not C", "same as A", "other than II"
  /\b(?:[Ee]xcept|[Ee]xcluding|[Bb]esides|[Oo]ther than|[Aa]part from|[Nn]ot|[Ss]ame as|[Ss]imilar to|[Ii]dentical to)\s+(?:option\s+|choice\s+)?\(?(?:[A-H]|[IVX]{1,4})\)?(?![A-Za-z0-9])/,
  // a bracketed label anywhere: "(a)", "(ii)", "(3)"
  /\(\s*(?:[a-h]|[ivx]{1,4}|[1-9])\s*\)/i,
  // the option carries its own label prefix: "A. x", "b) x", "(c) x", "1. x", "A - x"
  /^\s*\(?(?:[a-h]|[1-9])[.):]\s+\S|^\s*\(?[a-h]\)?\s+[-–—]\s+\S/i,
  // a bare capital-letter code: "AB", "ACD"
  /^\s*\(?[A-H]{2,4}\)?\s*$/,
  // a capital letter standing for an option / statement: "A is true", "B only"
  /(?<![A-Za-z0-9'’])[A-H](?![A-Za-z0-9'’])\s+(?:is|are|alone|only)\b/,
  // numeral lists: "1 and 3", "II, III"
  /(?<![\w.])(?:[1-9]|[IVX]{1,4})\s*(?:,|&|and|or|nor)\s*(?:[1-9]|[IVX]{1,4})(?!\w|\.\d)/,
];

/** Two or more standalone capital letters A-H = a list of labels: "A and C", "A, B", "A as well as B", "A-C", "A + B". */
const CAPITAL_LABEL = /(?<![A-Za-z0-9'’])[A-H](?![A-Za-z0-9'’])/g;

const LABEL = /^(?:[a-h]|[ivx]{1,4}|[1-9])$/;
const GLUE = new Set([
  "and", "or", "nor", "only", "both", "either", "neither", "all", "none", "any", "of", "the",
  "these", "those", "them", "above", "below", "option", "options", "choice", "choices",
  "answer", "answers", "statement", "statements",
]);
const TOKEN = /\d+(?:\.\d+)?|[a-z]+/g;

/** The whole option is only labels + glue words: "A", "(b)", "a and c", "Only B", "None of these". */
function isLabelOnly(text: string): boolean {
  const lower = text.toLowerCase();
  const tokens = lower.match(TOKEN);
  if (tokens === null || !tokens.every((t) => LABEL.test(t) || GLUE.has(t))) return false;
  // Only commas / "&" / brackets / full stops may sit between the tokens: "x = 5", "2/3", "1:2"
  // are values, not label text.
  if (/[^\s,&().;]/.test(lower.replace(TOKEN, ""))) return false;
  return !(tokens.length === 1 && /^\d/.test(tokens[0] ?? "")); // a lone number is a value, not a label
}

function isReferential(text: string): boolean {
  return (
    isLabelOnly(text) ||
    (text.match(CAPITAL_LABEL)?.length ?? 0) >= 2 ||
    // short quantifier-ish options: "All four", "Any one", "Every one"
    (text.trim().split(/\s+/).length <= 3 && /\b(?:all|any|each|every|some)\b/i.test(text)) ||
    REFERENTIAL.some((re) => re.test(text))
  );
}

/**
 * A letter of a script other than Latin / Greek (Devanagari, Arabic, Cyrillic, CJK ...).
 * The detector above reads English only, so options written in another script cannot be
 * proven free of "all of the above"-style references. (Greek stays shufflable: π, θ, Δ
 * are maths symbols in quantitative options.)
 */
const FOREIGN_LETTER = /(?![\p{Script=Latin}\p{Script=Greek}])\p{L}/u;

/** True when any option refers to its siblings by position, label or collectively. */
export function optionsCrossReference(options: readonly string[]): boolean {
  return options.some(isReferential);
}

// ---------------------------------------------------------------------------
// 2. Generating the per-attempt order (at startAttempt)
// ---------------------------------------------------------------------------

/**
 * A fresh random permutation for these frozen options, or null (= keep the
 * authored order) when they are not 2-8 non-empty strings, are written in a
 * script the detector cannot read, or refer to each other. `rng` is injectable
 * for tests; production uses Math.random, like the question-order shuffle
 * (decision #20: not reproducible by design).
 */
export function buildOptionOrder(options: unknown, rng: () => number = Math.random, maxOptions: number = MAX_OPTIONS): number[] | null {
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > maxOptions) return null;
  if (!options.every((o) => typeof o === "string" && o.trim() !== "")) return null;
  if ((options as string[]).some((o) => FOREIGN_LETTER.test(o))) return null; // cannot read it: leave it alone
  if (optionsCrossReference(options as string[])) return null;
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  return order;
}

/**
 * ordering questions: the per-attempt display order for the frozen `items`, ALWAYS shuffled
 * (ignores assessments.randomize and the cross-reference detector: authors usually write the
 * items already in the right order, so an unshuffled list would hand out the key). The order is
 * never equal to `correctOrder`; if the draw lands on it, rotate by one. Returns null only for
 * malformed content (then nothing is served shuffled and the answer scores 0 anyway).
 * order[displayPosition] = original item index, same model as the MCQ option order.
 */
export function buildOrderingOrder(items: unknown, correctOrder: unknown, rng: () => number = Math.random): number[] | null {
  // No MAX_SHUFFLE_OPTIONS cap here: a null order would serve the authored (= correct) order.
  // The content schema caps items at 10.
  if (!Array.isArray(items) || items.length < MIN_OPTIONS) return null;
  const n = items.length;
  const key = usableOrder(correctOrder);
  if (key === null || key.length !== n) return null;
  let order = items.map((_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  if (order.every((v, i) => v === key[i])) order = order.map((_, i) => order[(i + 1) % n] as number);
  return order;
}

/**
 * The stored order if it is a valid permutation of 0..n-1 (n >= 2), else null.
 * Both seams go through this, so a corrupt value degrades to "original order"
 * identically on save and on read.
 */
export function usableOrder(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS) return null;
  const seen = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= raw.length || seen.has(v)) return null;
    seen.add(v);
  }
  return raw as number[];
}

// ---------------------------------------------------------------------------
// 3. Translating answers (saveAnswer: display -> original; reads: original -> display)
// ---------------------------------------------------------------------------

/**
 * Remap the selected option index of an MCQ answer. Accepts the canonical
 * `{ selected: <int> }` and a bare integer (both are what 09-scoring accepts) and
 * always returns the canonical object when it translates. Anything that is not an
 * integer in [0, order.length) comes back untouched (see FAIL-SAFE above).
 */
export type AnswerKey = "selected" | "order";

function remapSelected(answer: unknown, order: readonly number[], toDisplay: boolean, key: AnswerKey): unknown {
  const isObject = answer !== null && typeof answer === "object" && !Array.isArray(answer);
  // `key` comes from the QUESTION TYPE (ordering -> "order", else "selected"), never from the
  // answer's shape: a crafted `{selected, order}` must not skip translation (codex review 2026-10-02).
  const raw = isObject ? (answer as Record<string, unknown>)[key] : key === "selected" ? answer : undefined;
  const mapOne = (v: unknown): number | undefined => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= order.length) return undefined;
    const m = toDisplay ? order.indexOf(v) : order[v];
    return m === undefined || m < 0 ? undefined : m;
  };
  // multi_select: an array of indexes. All-or-nothing translation: one bad element
  // leaves the whole answer untouched (FAIL-SAFE above).
  if (Array.isArray(raw)) {
    const mapped = raw.map(mapOne);
    if (mapped.some((m) => m === undefined)) return answer;
    return isObject ? { ...(answer as object), [key]: mapped } : { [key]: mapped };
  }
  if (key === "order") return answer; // ordering answers are arrays only
  const mapped = mapOne(raw);
  if (mapped === undefined) return answer;
  return isObject ? { ...(answer as object), selected: mapped } : { selected: mapped };
}

/** Candidate-sent DISPLAYED index -> ORIGINAL index (what is stored and scored). */
export function answerToOriginal(answer: unknown, order: readonly number[], key: AnswerKey = "selected"): unknown {
  return remapSelected(answer, order, false, key);
}

/** Stored ORIGINAL index -> the DISPLAYED index the candidate chose. */
export function answerToDisplayed(answer: unknown, order: readonly number[], key: AnswerKey = "selected"): unknown {
  return remapSelected(answer, order, true, key);
}

// ---------------------------------------------------------------------------
// 4. Serving the candidate view (getAttemptForCandidate / listAnswersForAttempt)
// ---------------------------------------------------------------------------

/** Frozen questions with MCQ `content.options` rearranged into each attempt's display order. */
// ponytail: structured_case steps are NOT shuffled (served in authored order); shuffling per step
// (own option_order per step id) is the upgrade if option position becomes a cue.
export function displayQuestions(
  questions: FrozenQuestion[],
  orders: ReadonlyMap<string, readonly number[]>,
): FrozenQuestion[] {
  return questions.map((q) => {
    const order = usableOrder(orders.get(q.question_id));
    // ordering without a usable order: never serve the authored (= correct) item order. Fail closed.
    if (order === null) return q.type === "ordering" ? { ...q, content: { ...(q.content as object), items: [] } } : q;
    const content = q.content as { options?: unknown; items?: unknown } | null;
    // MCQ / multi_select shuffle `options`; ordering shuffles `items` (same permutation model).
    const field = q.type === "ordering" ? "items" : "options";
    const options = content !== null && typeof content === "object" ? content[field] : undefined;
    // question_versions is insert-only and attempt_questions pins the version, so an
    // order always matches its frozen options. If it ever does not, fail loudly: serving
    // the authored order while saves still translate would silently mis-score.
    if (!Array.isArray(options) || options.length !== order.length) {
      throw new Error(`option_order does not match the frozen options of question ${q.question_id}`);
    }
    return { ...q, content: { ...content, [field]: order.map((i) => options[i]) } };
  });
}

/** The candidate's saved answers with MCQ `selected` mapped back to the displayed position. */
export function displayAnswers(
  answers: AttemptAnswer[],
  orders: ReadonlyMap<string, readonly number[]>,
  orderingIds: ReadonlySet<string> = new Set(),
): AttemptAnswer[] {
  return answers.map((a) => {
    const order = usableOrder(orders.get(a.question_id));
    const key: AnswerKey = orderingIds.has(a.question_id) ? "order" : "selected";
    return order === null ? a : { ...a, answer: answerToDisplayed(a.answer, order, key) };
  });
}
