import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

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
};
