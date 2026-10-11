import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, pickKeys, questionOrJson, questionStem, structuralOf } from "../../helpers.js";

export const NumericContentSchema = z.object({
  question: z.string().min(1),
  answer: z.number().finite(),
  tolerance: z.number().finite().min(0).optional(),
  unit: z.string().min(1).max(20).optional(),
  rationale: z.string().min(1).optional(),
}).strict();

export type NumericContent = z.infer<typeof NumericContentSchema>;

/** LOOSE (narrowing only, never rejects a stored answer): mirrors parseNumericAnswer in 09. */
export const NumericAnswerPayloadSchema = z.union([
  z.number(),
  z.string(),
  z.object({ value: z.union([z.number(), z.string()]) }).passthrough(),
]);

/** Extract the numeric value of a stored numeric answer: number, {value}, or numeric string ("1,250"). */
export function parseNumericAnswer(answer: unknown): number | null {
  let v: unknown = answer;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) v = (v as { value?: unknown }).value;
  if (typeof v === "string") {
    const t = v.trim().replace(/,/g, "");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
    v = Number(t);
  }
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** numeric: correct iff |given - answer| <= tolerance (absolute, default 0). Never throws. */
export function isNumericAnswerCorrect(content: unknown, answer: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  const c = content as { answer?: unknown; tolerance?: unknown };
  if (typeof c.answer !== "number" || !Number.isFinite(c.answer)) return false;
  const tol = typeof c.tolerance === "number" && Number.isFinite(c.tolerance) && c.tolerance >= 0 ? c.tolerance : 0;
  const given = parseNumericAnswer(answer);
  if (given === null) return false;
  // 1e-9 slack so float noise at the tolerance edge (0.1 + 0.2) does not flip a result
  return Math.abs(given - c.answer) <= tol + 1e-9;
}

export const definition: QuestionTypeDef = {
  id: "numeric",
  label: "Numeric",
  contentSchema: NumericContentSchema,
  answerSchema: NumericAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "answer", required: true }, { key: "tolerance", required: false }, { key: "unit", required: false }],
  qtiInteraction: "textEntryInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.numeric",
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: null,
  // answer, tolerance and rationale never leave the server.
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "unit"])),
  coerceContent: (raw) => raw,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  deterministicScore: (content, answer) => (isNumericAnswerCorrect(content, answer) ? 1 : 0),
  evalStructuralCheck: structuralOf(NumericContentSchema, () => null),
};
