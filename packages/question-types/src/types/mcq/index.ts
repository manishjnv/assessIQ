import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { asStr, candidateViewOf, compact, isObj, pick, pickKeys, questionOrJson, questionStem, structuralOf, type Dict } from "../../helpers.js";

export const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.number().int().min(0),
  rationale: z.string().min(1),
}).strict()
  .superRefine((val, ctx) => {
    if (val.correct >= val.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: "correct must be a valid index into options",
      });
    }
  });

export type McqContent = z.infer<typeof McqContentSchema>;

export const McqAnswerPayloadSchema = z.object({
  /** Index into content.options[], 0-7 (options allow 2-8). */
  selected: z.number().int().min(0).max(7),
});

/**
 * Pure correctness check. content is the frozen question_versions.content, answer the stored answer.
 * Never throws. Accepted answer shapes: {selected: int} (canonical) or a bare integer.
 */
export function isMcqAnswerCorrect(content: unknown, answer: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  const c = content as { correct?: unknown; options?: unknown };
  const correct = c.correct;
  if (typeof correct !== "number" || !Number.isInteger(correct) || correct < 0) return false;
  if (Array.isArray(c.options) && correct >= c.options.length) return false;

  let selected: unknown = answer;
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) {
    selected = (answer as { selected?: unknown }).selected;
  }
  if (typeof selected !== "number" || !Number.isInteger(selected)) return false;
  return selected === correct;
}

/** Attempted iff a selected option index is present: {selected: int} or a bare integer. Never throws. */
export function isMcqAttempted(answer: unknown): boolean {
  const s = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? (answer as { selected?: unknown }).selected : answer;
  return typeof s === "number" && Number.isInteger(s);
}

// ---- generator-output coercion (moved verbatim from 07 coerce-question-content.ts) ----

/** Coerce an MCQ option entry (string or object) to a plain string. */
function optionToString(o: unknown): string | undefined {
  if (typeof o === "string") return o;
  if (isObj(o)) return asStr(pick(o, ["text", "label", "option", "value", "answer", "content", "choice"]));
  return undefined;
}

/** Resolve ONE answer signal to a 0-based index, or undefined if ambiguous/unresolvable. */
function signalToIndex(sig: unknown, stringOptions: string[]): number | undefined {
  if (typeof sig === "number") return Number.isInteger(sig) ? sig : undefined;
  if (typeof sig === "string") {
    const s = sig.trim();
    if (s === "") return undefined;
    // Single option letter (A-H), optionally followed by ) . : ]
    const letterChar = /^([A-Ha-h])[).:\]]?$/.exec(s)?.[1];
    if (letterChar) return letterChar.toUpperCase().charCodeAt(0) - 65;
    // Exact, UNIQUE option-text match (case-insensitive). Ambiguous/no match -> undefined.
    const matches: number[] = [];
    stringOptions.forEach((o, i) => {
      if (o.trim().toLowerCase() === s.toLowerCase()) matches.push(i);
    });
    if (matches.length === 1) return matches[0];
    // Quoted numbers ("1") are intentionally NOT coerced: 0-based vs 1-based is ambiguous.
    return undefined;
  }
  return undefined;
}

/** Indices of option objects explicitly flagged correct. */
function flaggedOptionIndices(rawOptions: unknown): number[] {
  if (!Array.isArray(rawOptions)) return [];
  const out: number[] = [];
  rawOptions.forEach((o, i) => {
    if (isObj(o) && (o.correct === true || o.is_correct === true || o.isCorrect === true)) {
      out.push(i);
    }
  });
  return out;
}

/** Resolve the MCQ correct index across all signals; undefined => fail closed. */
function resolveCorrectIndex(c: Dict, rawOptions: unknown, stringOptions: string[]): number | undefined {
  const indices = new Set<number>();
  const explicitSignals = [
    c.correct, c.correct_index, c.correct_option, c.correct_answer,
    c.answer, c.correct_option_id, c.answer_index, c.answer_key,
  ];
  for (const sig of explicitSignals) {
    if (sig === undefined || sig === null) continue; // absent signal - fine
    const idx = signalToIndex(sig, stringOptions);
    // A PRESENT answer-key signal we cannot unambiguously resolve MUST fail closed.
    if (idx === undefined) return undefined;
    indices.add(idx);
  }
  for (const fi of flaggedOptionIndices(rawOptions)) indices.add(fi);
  return indices.size === 1 ? [...indices][0] : undefined;
}

function coerceMcqContent(c: Dict): Dict {
  const rawOptions = pick(c, ["options", "choices", "answers", "answer_options"]);
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((o) => optionToString(o) ?? o)
    : rawOptions;
  const stringOptions = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [];
  return compact({
    question: pick(c, ["question", "stem", "prompt", "text", "question_text"]),
    options,
    correct: resolveCorrectIndex(c, rawOptions, stringOptions),
    rationale: pick(c, ["rationale", "explanation", "rationale_text", "justification", "reason", "answer_explanation"]),
  });
}

export const definition: QuestionTypeDef = {
  id: "mcq",
  label: "Multiple choice",
  contentSchema: McqContentSchema,
  answerSchema: McqAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "options", required: true }, { key: "correct", required: true }, { key: "rationale", required: true }],
  qtiInteraction: "choiceInteraction",
  generatorSkill: "generate-mcq",
  scoring: "deterministic",
  helpKey: "question_type.mcq",
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: "options",
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "options"])),
  coerceContent: coerceMcqContent,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  deterministicScore: (content, answer) => (isMcqAnswerCorrect(content, answer) ? 1 : 0),
  isAttempted: isMcqAttempted,
  evalStructuralCheck: structuralOf(McqContentSchema, (d) => (d.options.length === 4 ? null : "mcq: options.length !== 4")),
};
