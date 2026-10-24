// EXP-6: "Start a full mock" — a DRAFT assessment built from a platform exam blueprint through the
// existing createAssessment path (all of its guards run: pack published, level in pack, opens_at, tenant RLS).
// Z-123: each section carries the blueprint subject node (node_id); module 06 draws it by taxonomy descendants.
import { getExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import type { Assessment, AssessmentSection } from "../types.js";
import { createAssessment } from "./assessments.js";

export interface CreateMockInput {
  pack_id: string;
  level_id: string;
  opens_at: Date | null;
  closes_at?: Date | null;
  name?: string;
  delivery_mode?: "real" | "mock";
  camera_required?: boolean;
}

export async function createMockFromBlueprint(
  tenantId: string,
  blueprintId: string,
  input: CreateMockInput,
  createdByUserId: string,
): Promise<{ assessment: Assessment; warnings: string[] }> {
  const bp = await getExamBlueprint(tenantId, blueprintId);
  const warnings: string[] = [];

  // Z-42: sections are all timed one by one, or the whole test has ONE timer (settings.whole_test_minutes)
  // and the candidate moves freely. The blueprint forbids a mix. Marks and penalties are per section and
  // are frozen into attempt_questions at attempt start (module 06), so no even split of the minutes.
  const sectional = bp.sections.every((s) => s.sectional_timing);
  if (bp.verification_status !== "verified") warnings.push("This blueprint is not verified.");

  const sections: AssessmentSection[] = bp.sections.map((s) => ({
    name: s.name,
    question_count: s.question_count,
    ...(s.subject_node_id !== null ? { node_id: s.subject_node_id } : {}), // Z-123: the draw filters by this node
    ...(sectional ? { minutes: s.minutes as number } : {}),
    marks_per_question: s.marks_per_question,
    negative_marks_per_question: s.negative_marks_per_question,
    ...(s.calculator_allowed ? { calculator: true } : {}),
    allowed_types: s.allowed_types as AssessmentSection["allowed_types"], // EXP-34: the draw now enforces it
    ...(s.qualifying ? { qualifying: true } : {}),
    ...(s.qualifying && s.cutoff_marks !== null ? { cutoff_marks: s.cutoff_marks } : {}),
  }));

  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: input.pack_id,
      level_id: input.level_id,
      name: input.name?.trim() || `${bp.name} full mock`,
      question_count: bp.total_questions,
      ...(input.delivery_mode !== undefined ? { delivery_mode: input.delivery_mode } : {}),
      ...(input.camera_required !== undefined ? { camera_required: input.camera_required } : {}),
      opens_at: input.opens_at,
      ...(input.closes_at !== undefined ? { closes_at: input.closes_at } : {}),
      settings: {
        sections,
        ...(sectional ? {} : { whole_test_minutes: bp.total_minutes }),
        exam_blueprint: { id: bp.id, edition: bp.edition, verification_status: bp.verification_status },
      },
    },
    createdByUserId,
  );
  return { assessment, warnings };
}
