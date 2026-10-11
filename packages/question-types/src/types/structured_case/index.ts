import { z } from "zod";
import type { CheckAnswerResult, QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, pickKeys, questionOrJson, questionStem, structuralOf, type Dict } from "../../helpers.js";
import { multiSelectFraction } from "../multi_select/index.js";

export const StructuredCaseStepSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  select: z.enum(["one", "many"]),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.array(z.number().int().min(0)).min(1),
}).strict();

export const StructuredCaseContentSchema = z.object({
  title: z.string().min(1),
  context: z.string().min(1),
  log_excerpt: z.string().min(1).max(20000).optional(),
  steps: z.array(StructuredCaseStepSchema).min(1).max(12),
  scoring: z.enum(["all_or_nothing", "partial"]).optional(),
  explanation: z.string().min(1).optional(),
}).strict()
  .superRefine((val, ctx) => {
    if (new Set(val.steps.map((s) => s.id)).size !== val.steps.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "step ids must be unique" });
    }
    val.steps.forEach((s, i) => {
      if (new Set(s.correct).size !== s.correct.length || s.correct.some((c) => c >= s.options.length)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "correct"], message: "correct must be unique, valid indexes into options" });
      }
      if (s.select === "one" && s.correct.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "correct"], message: "select 'one' needs exactly one correct index" });
      }
    });
  });

export type StructuredCaseContent = z.infer<typeof StructuredCaseContentSchema>;

/** structured_case answer: picked option indexes per step id. Range / id checks need the frozen content (checkAnswerForSave). */
export const StructuredCaseAnswerPayloadSchema = z.object({
  steps: z.record(z.string(), z.array(z.number().int().min(0))),
});

/**
 * structured_case: fraction of the points earned, 0..1. Answer { steps: { [stepId]: number[] } }
 * (ORIGINAL option indexes; no shuffle for this type). Per step: select 'one' -> 1 iff the single
 * selected index equals correct[0]; select 'many' -> multiSelectFraction on that step (partial only
 * when the question's scoring is 'partial'). Question: all_or_nothing -> 1 iff every step is 1;
 * partial (default) -> mean of the step fractions. Malformed content/answer -> 0.
 */
export function structuredCaseFraction(content: unknown, answer: unknown): number {
  if (content === null || typeof content !== "object") return 0;
  const c = content as { steps?: unknown; scoring?: unknown };
  if (!Array.isArray(c.steps) || c.steps.length === 0) return 0;
  const given = answer !== null && typeof answer === "object" && !Array.isArray(answer)
    ? (answer as { steps?: unknown }).steps
    : undefined;
  if (given === null || typeof given !== "object" || Array.isArray(given)) return 0;
  const picks = given as Record<string, unknown>;
  const stepIds = new Set(c.steps.map((s) => (s !== null && typeof s === "object" ? (s as { id?: unknown }).id : undefined)));
  if (Object.keys(picks).some((k) => !stepIds.has(k))) return 0; // unknown step id -> malformed
  const fractions = c.steps.map((s): number => {
    if (s === null || typeof s !== "object") return 0;
    const st = s as { id?: unknown; select?: unknown; options?: unknown; correct?: unknown };
    if (typeof st.id !== "string" || !Object.prototype.hasOwnProperty.call(picks, st.id)) return 0;
    const sel = picks[st.id];
    if (st.select === "one") {
      const key = Array.isArray(st.correct) && st.correct.length === 1 ? st.correct[0] : undefined;
      return Array.isArray(sel) && sel.length === 1 && typeof key === "number" && sel[0] === key ? 1 : 0;
    }
    return multiSelectFraction(
      { options: st.options, correct: st.correct, scoring: c.scoring === "all_or_nothing" ? "all_or_nothing" : "partial" },
      { selected: sel },
    );
  });
  if (c.scoring === "all_or_nothing") return fractions.every((f) => f === 1) ? 1 : 0;
  return fractions.reduce((a, b) => a + b, 0) / fractions.length;
}

/** Per-step allowlist id/prompt/select/options. correct, scoring and explanation never leave the server. */
function structuredCaseCandidateView(c: Dict): Dict {
  const base = pickKeys(c, ["title", "context", "log_excerpt"]);
  const rawSteps = c["steps"];
  base["steps"] = Array.isArray(rawSteps)
    ? rawSteps.map((st) => {
        const s = st !== null && typeof st === "object" ? (st as Dict) : {};
        return { id: s["id"], prompt: s["prompt"], select: s["select"], options: s["options"] };
      })
    : [];
  return base;
}

/**
 * Save-time check keyed on the TYPE. Canonical { steps: { [stepId]: number[] } }; every step id must
 * exist in the frozen content and every index must be a unique integer inside that step's options.
 */
function structuredCaseCheckAnswer(answer: unknown, frozenContent?: unknown): CheckAnswerResult {
  if (answer === null) return { ok: true, answer };
  const parsed = StructuredCaseAnswerPayloadSchema.safeParse(answer);
  const steps = (frozenContent as { steps?: unknown } | null | undefined)?.steps;
  if (!parsed.success || !Array.isArray(steps)) return { ok: false, reason: "structured_case answer must be { steps: { [stepId]: number[] } }" };
  const byId = new Map(
    steps.map((s: { id?: unknown; options?: unknown; select?: unknown }) => [s.id, { options: s.options, select: s.select }]),
  );
  for (const [id, picks] of Object.entries(parsed.data.steps)) {
    const step = byId.get(id);
    const options = step?.options;
    if (!Array.isArray(options) || new Set(picks).size !== picks.length || picks.some((i) => i >= options.length)) {
      return { ok: false, reason: "structured_case answer has an unknown step or an invalid option index" };
    }
    // A select-one step takes at most one pick (review note, 2026-10-03).
    if (step?.select === "one" && picks.length > 1) return { ok: false, reason: "structured_case select-one step has more than one pick" };
  }
  return { ok: true, answer: parsed.data };
}

export const definition: QuestionTypeDef = {
  id: "structured_case",
  label: "Structured case",
  contentSchema: StructuredCaseContentSchema,
  answerSchema: StructuredCaseAnswerPayloadSchema,
  importColumns: [{ key: "title", required: true }, { key: "context", required: true }, { key: "steps", required: true }],
  qtiInteraction: "choiceInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.structured_case",
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: null,
  candidateView: candidateViewOf(structuredCaseCandidateView),
  coerceContent: (raw) => raw,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  deterministicScore: structuredCaseFraction,
  evalStructuralCheck: structuralOf(StructuredCaseContentSchema, () => null),
  checkAnswer: structuredCaseCheckAnswer,
};
