// EXP-11: drill mode (admin path). A topic practice test: a DRAFT mock assessment with one section per chosen
// Subject-map node, a fixed question total split across the nodes, an optional difficulty range (FUT-9) and one
// whole-test timer. It goes through createAssessment (all guards run) and is scored by the normal fixed rules, so
// the result already shows per-section (per-topic) accuracy. No AI. Student self-service entry is not built.
import { ValidationError } from "@assessiq/core";
import type { Assessment, AssessmentSection } from "../types.js";
import { createAssessment } from "./assessments.js";

export interface CreateDrillInput {
  pack_id: string;
  level_id: string;
  node_ids: string[];
  question_count: number;
  difficulty_min?: number;
  difficulty_max?: number;
  /** Whole-test minutes. Absent = 1.5 minutes per question, rounded up. */
  minutes?: number;
  opens_at: Date | null;
  closes_at?: Date | null;
  name?: string;
}

/** Split `count` over the nodes: even share, the remainder goes to the first nodes. Pure; throws on a bad shape. */
export function buildDrillSections(nodeIds: string[], count: number, diffMin?: number, diffMax?: number): AssessmentSection[] {
  const nodes = [...new Set(nodeIds)];
  if (nodes.length === 0 || nodes.length > 10) throw new ValidationError("pick 1 to 10 topics", { details: { code: "INVALID_PARAM", param: "node_ids" } });
  if (!Number.isInteger(count) || count < nodes.length || count > 500) {
    throw new ValidationError("question_count must be at least the number of topics and at most 500", { details: { code: "INVALID_PARAM", param: "question_count" } });
  }
  const base = Math.floor(count / nodes.length);
  const extra = count % nodes.length;
  return nodes.map((node_id, i) => ({
    name: `Topic ${i + 1}`,
    node_id,
    question_count: base + (i < extra ? 1 : 0),
    ...(diffMin !== undefined ? { difficulty_min: diffMin } : {}),
    ...(diffMax !== undefined ? { difficulty_max: diffMax } : {}),
  }));
}

export async function createDrill(tenantId: string, input: CreateDrillInput, createdByUserId: string): Promise<{ assessment: Assessment }> {
  const sections = buildDrillSections(input.node_ids, input.question_count, input.difficulty_min, input.difficulty_max);
  const minutes = input.minutes ?? Math.ceil(input.question_count * 1.5);
  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: input.pack_id,
      level_id: input.level_id,
      name: input.name?.trim() || "Topic drill",
      question_count: input.question_count,
      delivery_mode: "mock",
      opens_at: input.opens_at,
      ...(input.closes_at !== undefined ? { closes_at: input.closes_at } : {}),
      settings: { sections, whole_test_minutes: Math.min(600, Math.max(1, minutes)), drill: true },
    },
    createdByUserId,
  );
  return { assessment };
}
