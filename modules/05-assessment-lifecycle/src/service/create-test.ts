// CT-2: "Create a test". One call for every cover (whole set, chosen topics, exam pattern): compileTestSpec turns the pick
// into assessment fields, createAssessment (all guards run: pack published, level in pack, caps, integrity, camera, RLS)
// saves it as a DRAFT. Nothing is published or invited here: the admin finishes on the assessment page.
// The type-card settings (integrity, feedback level) and the type (delivery_mode, camera) reach createAssessment on every
// cover, so a topic test or a pattern test can never skip them (RCA 2026-10-26).
import { withTenant } from "@assessiq/tenancy";
import { getExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import type { Assessment } from "../types.js";
import { createAssessment } from "./assessments.js";
import { compileTestSpec, type TestCover } from "./compile-test.js";

export interface CreateTestInput {
  pack_id: string;
  level_id: string;
  name?: string;
  cover: TestCover;
  minutes?: number;
  difficulty_min?: number;
  difficulty_max?: number;
  delivery_mode: "real" | "mock";
  camera_required?: boolean;
  opens_at: Date | null;
  closes_at?: Date | null;
  /** Type-card settings, merged as given; createAssessment validates them. */
  settings?: { integrity?: { fullscreen: boolean; block_copy_paste: boolean }; feedback_level?: "none" | "right_wrong" | "with_expected_answer" | "with_ai_justification" };
  /** Platform-side date label for the default name. */
  today?: string;
}

async function topicNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = await withTenant(tenantId, async (client) => (await client.query<{ id: string; name: string }>(
    `SELECT id, label AS name FROM taxonomy_nodes WHERE id = ANY($1::uuid[])`, [ids])).rows);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function createTest(tenantId: string, input: CreateTestInput, createdByUserId: string): Promise<{ assessment: Assessment; warnings: string[] }> {
  const blueprint = input.cover.kind === "pattern" ? await getExamBlueprint(tenantId, input.cover.blueprint_id) : undefined;
  const names = input.cover.kind === "topics" && input.cover.topics.length > 0 && input.cover.topics.length <= 10
    ? await topicNames(tenantId, input.cover.topics.map((t) => t.node_id))
    : undefined;
  const compiled = compileTestSpec({
    cover: input.cover,
    ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
    ...(input.difficulty_min !== undefined ? { difficulty_min: input.difficulty_min } : {}),
    ...(input.difficulty_max !== undefined ? { difficulty_max: input.difficulty_max } : {}),
    ...(names !== undefined ? { topicNames: names } : {}),
    ...(blueprint !== undefined ? { blueprint } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.today !== undefined ? { today: input.today } : {}),
  });
  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: input.pack_id,
      level_id: input.level_id,
      name: compiled.name,
      question_count: compiled.question_count,
      ...(compiled.duration_minutes !== undefined ? { duration_minutes: compiled.duration_minutes } : {}),
      delivery_mode: input.delivery_mode,
      ...(input.camera_required !== undefined ? { camera_required: input.camera_required } : {}),
      opens_at: input.opens_at,
      ...(input.closes_at !== undefined ? { closes_at: input.closes_at } : {}),
      settings: { ...input.settings, ...compiled.settings },
    },
    createdByUserId,
  );
  return { assessment, warnings: compiled.warnings };
}
