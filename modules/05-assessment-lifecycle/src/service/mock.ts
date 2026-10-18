// EXP-6: "Start a full mock" — a DRAFT assessment built from a platform exam blueprint through the
// existing createAssessment path (all of its guards run: pack published, level in pack, opens_at, tenant RLS).
// Section subject nodes are NOT used by the draw today: a section draws from the pack/level pool by
// question_count (module 06 startAttempt), so the pool must be built for the exam. Rewrite of the draw
// by node is EXP-5 follow-up work, not done here.
import { getExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import type { Assessment, AssessmentSection } from "../types.js";
import { createAssessment } from "./assessments.js";

export interface CreateMockInput {
  pack_id: string;
  level_id: string;
  opens_at: Date | null;
  closes_at?: Date | null;
  name?: string;
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
    ...(sectional ? { minutes: s.minutes as number } : {}),
    marks_per_question: s.marks_per_question,
    negative_marks_per_question: s.negative_marks_per_question,
    ...(s.calculator_allowed ? { calculator: true } : {}),
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
