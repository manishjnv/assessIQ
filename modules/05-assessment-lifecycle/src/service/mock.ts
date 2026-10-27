// EXP-6: "Start a full mock" — a DRAFT assessment built from a platform exam blueprint through the
// existing createAssessment path (all of its guards run: pack published, level in pack, opens_at, tenant RLS).
// Z-123: each section carries the blueprint subject node (node_id); module 06 draws it by taxonomy descendants.
import { getExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import { ValidationError } from "@assessiq/core";
import type { Assessment } from "../types.js";
import { createAssessment } from "./assessments.js";
import { compilePatternSections } from "./compile-test.js";

export interface CreateMockInput {
  pack_id: string;
  level_id: string;
  opens_at: Date | null;
  closes_at?: Date | null;
  name?: string;
  delivery_mode?: "real" | "mock";
  camera_required?: boolean;
  /** EXP-35: 0-based blueprint section positions for a short mock. Absent = all sections. */
  section_positions?: number[];
  /** EXP-35: scale every chosen section's question count (and minutes) to this percent, 1..100. Absent = 100. */
  scale_percent?: number;
  /** EXP-35: fixed total question count for a short mock (1..100, not above the chosen sections). Not with scale_percent. */
  question_count?: number;
}

export async function createMockFromBlueprint(
  tenantId: string,
  blueprintId: string,
  input: CreateMockInput,
  createdByUserId: string,
): Promise<{ assessment: Assessment; warnings: string[] }> {
  const bp = await getExamBlueprint(tenantId, blueprintId);
  const warnings: string[] = [];
  if (bp.archived_at !== null) {
    throw new ValidationError("This exam pattern is archived. Pick a current pattern.", { details: { code: "INVALID_PARAM", param: "blueprint_id" } });
  }

  // CT-2: sections, size and timing come from the one shared pattern builder (compile-test.ts).
  const { sections, total, wholeMinutes, isShort } = compilePatternSections(bp, { section_positions: input.section_positions, scale_percent: input.scale_percent, question_count: input.question_count });
  if (bp.verification_status !== "verified") warnings.push("This blueprint is not verified.");
  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: input.pack_id,
      level_id: input.level_id,
      name: input.name?.trim() || `${bp.name} ${isShort ? "practice mock" : "full mock"}`,
      question_count: total,
      ...(input.delivery_mode !== undefined ? { delivery_mode: input.delivery_mode } : {}),
      ...(input.camera_required !== undefined ? { camera_required: input.camera_required } : {}),
      opens_at: input.opens_at,
      ...(input.closes_at !== undefined ? { closes_at: input.closes_at } : {}),
      settings: {
        sections,
        ...(wholeMinutes === null ? {} : { whole_test_minutes: wholeMinutes }),
        exam_blueprint: { id: bp.id, edition: bp.edition, verification_status: bp.verification_status },
      },
    },
    createdByUserId,
  );
  return { assessment, warnings };
}
