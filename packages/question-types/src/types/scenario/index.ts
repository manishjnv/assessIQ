import { z } from "zod";
import type { CheckAnswerResult, QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, compact, isObj, pick, pickKeys, questionOrJson, str, structuralOf, type Dict } from "../../helpers.js";

const ScenarioStepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("mcq"),
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    correct: z.number().int().min(0),
    trap: z.boolean().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    type: z.literal("subjective"),
    prompt: z.string().min(1),
    rubric_ref: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    type: z.literal("kql"),
    prompt: z.string().min(1),
    expected_keywords: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export const ScenarioContentSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  step_dependency: z.enum(["linear", "parallel"]),
}).strict();

export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;

export const ScenarioStepAnswerSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  response: z.string(),
});

export const ScenarioAnswerPayloadSchema = z.object({
  steps: z.array(ScenarioStepAnswerSchema),
});

/** Map a boolean / synonym step_dependency onto the canonical enum (present values only). */
function coerceStepDependency(v: unknown): unknown {
  if (typeof v === "boolean") return v ? "dag" : "linear";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "linear" || s === "dag") return s;
    if (s === "true") return "dag";
    if (s === "false" || /sequential|order|chain|step.?by.?step/.test(s)) return "linear";
    if (/graph|tree|branch|depend/.test(s)) return "dag";
  }
  return v; // absent / unrecognised -> leave for Zod (do not invent for missing)
}

function coerceScenarioContent(c: Dict): Dict {
  const rawSteps = pick(c, ["steps", "tasks", "parts", "questions"]);
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((s) => {
        if (isObj(s)) {
          return compact({
            prompt: pick(s, ["prompt", "question", "task", "step", "text", "instruction"]),
            expected: pick(s, ["expected", "expected_answer", "answer", "answer_key", "model_answer", "solution", "ideal_answer"]),
          });
        }
        // A plain-string step carries no expected answer; leave expected absent.
        return compact({ prompt: typeof s === "string" ? s : undefined });
      })
    : rawSteps;
  return compact({
    title: pick(c, ["title", "stem", "name", "heading", "scenario_title"]),
    intro: pick(c, ["intro", "description", "scenario", "scenario_text", "context", "background", "situation"]),
    step_dependency: coerceStepDependency(pick(c, ["step_dependency", "steps_dependency", "dependency", "dependency_type", "step_dependencies"])),
    steps,
  });
}

/**
 * Candidate view: title, intro, step_dependency and steps. Each step keeps prompt; mcq-typed steps
 * also id/type/options (strings only). correct, trap, expected and everything else stay server-side.
 */
function scenarioCandidateView(c: Dict): Dict {
  const base = pickKeys(c, ["title", "intro", "step_dependency"]);
  if (Object.prototype.hasOwnProperty.call(c, "steps")) {
    const rawSteps = c["steps"];
    if (Array.isArray(rawSteps)) {
      base["steps"] = rawSteps.map((step) => {
        if (step !== null && typeof step === "object" && !Array.isArray(step)) {
          const s = step as Dict;
          const stepOut: Dict = {};
          if (Object.prototype.hasOwnProperty.call(s, "prompt")) {
            stepOut["prompt"] = s["prompt"];
          }
          // Keyed on the declared step type; the generated {prompt, expected} shape keeps prompt only.
          if (s["type"] === "mcq" && Array.isArray(s["options"])) {
            stepOut["type"] = "mcq";
            if (typeof s["id"] === "string") stepOut["id"] = s["id"];
            stepOut["options"] = (s["options"] as unknown[]).filter(
              (o): o is string => typeof o === "string",
            );
          }
          return stepOut;
        }
        return step;
      });
    }
    // if steps is not an array, omit it entirely
  }
  return base;
}

/** Candidate-visible text only: title, intro and each step prompt. Never steps[].expected. */
function scenarioGuidanceText(content: unknown): string {
  const c = (content ?? {}) as Dict;
  const parts: string[] = [str(c.title), str(c.intro)];
  if (Array.isArray(c.steps)) {
    for (const s of c.steps) {
      if (s && typeof s === "object") parts.push(str((s as Dict).prompt));
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

/** Reference concepts a synthesised rubric anchors on: steps[].expected (non-blank strings). */
function scenarioSynthConcepts(content: unknown): string[] {
  const steps = (content as Dict | null | undefined)?.["steps"];
  return Array.isArray(steps)
    ? steps
        .map((s) => (s && typeof s === "object" ? (s as Dict)["expected"] : undefined))
        .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
}

/** Save-time shape check. The grader reads steps, so a wrong shape would be evaluated as empty (N15). */
function scenarioCheckAnswer(answer: unknown): CheckAnswerResult {
  if (answer === null) return { ok: true, answer };
  const parsed = ScenarioAnswerPayloadSchema.safeParse(answer);
  return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: "scenario answer must be { steps: [{ stepIndex, response }] }" };
}

export const definition: QuestionTypeDef = {
  id: "scenario",
  label: "Scenario",
  contentSchema: ScenarioContentSchema,
  answerSchema: ScenarioAnswerPayloadSchema,
  importColumns: [{ key: "title", required: true }, { key: "intro", required: true }, { key: "steps", required: true }, { key: "step_dependency", required: true }],
  qtiInteraction: "extendedTextInteraction",
  generatorSkill: "generate-scenario",
  scoring: "ai",
  helpKey: "question_type.scenario",
  aiGradeable: true,
  rubricRequired: true,
  rubricSynthesis: "steps_expected",
  shuffleField: null,
  candidateView: candidateViewOf(scenarioCandidateView),
  coerceContent: coerceScenarioContent,
  guidanceText: scenarioGuidanceText,
  rubricText: questionOrJson,
  synthConcepts: scenarioSynthConcepts,
  evalStructuralCheck: structuralOf(ScenarioContentSchema, (d) => (d.steps.length >= 1 ? null : "scenario: steps.length < 1")),
  checkAnswer: scenarioCheckAnswer,
};
