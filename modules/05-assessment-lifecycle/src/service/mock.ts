// EXP-6: "Start a full mock" — a DRAFT assessment built from a platform exam blueprint through the
// existing createAssessment path (all of its guards run: pack published, level in pack, opens_at, tenant RLS).
// Z-123: each section carries the blueprint subject node (node_id); module 06 draws it by taxonomy descendants.
import { getExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import { ValidationError } from "@assessiq/core";
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
  /** EXP-35: 0-based blueprint section positions for a short mock. Absent = all sections. */
  section_positions?: number[];
  /** EXP-35: scale every chosen section's question count (and minutes) to this percent, 1..100. Absent = 100. */
  scale_percent?: number;
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
  // EXP-35: a short mock (section subset and/or scaled size). Marks per question stay; cutoffs and qualifying flags do not apply.
  const picked = input.section_positions === undefined ? null : new Set(input.section_positions);
  if (picked !== null && (picked.size === 0 || [...picked].some((i) => !Number.isInteger(i) || i < 0 || i >= bp.sections.length))) {
    throw new ValidationError("section_positions must list valid blueprint sections", { details: { code: "INVALID_PARAM", param: "section_positions" } });
  }
  const pct = input.scale_percent ?? 100;
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
    throw new ValidationError("scale_percent must be a whole number from 1 to 100", { details: { code: "INVALID_PARAM", param: "scale_percent" } });
  }
  const isShort = picked !== null || pct < 100;
  const scale = (n: number) => Math.max(1, Math.round((n * pct) / 100));
  if (bp.verification_status !== "verified") warnings.push("This blueprint is not verified.");

  const sections: AssessmentSection[] = bp.sections.filter((_, i) => picked === null || picked.has(i)).map((s) => ({
    name: s.name,
    question_count: isShort ? scale(s.question_count) : s.question_count,
    ...(s.subject_node_id !== null ? { node_id: s.subject_node_id } : {}), // Z-123: the draw filters by this node
    ...(sectional ? { minutes: isShort ? scale(s.minutes as number) : (s.minutes as number) } : {}),
    marks_per_question: s.marks_per_question,
    negative_marks_per_question: s.negative_marks_per_question,
    ...(s.calculator_allowed ? { calculator: true } : {}),
    allowed_types: s.allowed_types as AssessmentSection["allowed_types"], // EXP-34: the draw now enforces it
    ...(!isShort && s.qualifying ? { qualifying: true } : {}),
    ...(!isShort && s.qualifying && s.cutoff_marks !== null ? { cutoff_marks: s.cutoff_marks } : {}),
  }));

  const total = sections.reduce((n, s) => n + (s.question_count ?? 0), 0);
  const wholeMinutes = isShort ? Math.min(600, Math.max(1, Math.ceil((bp.total_minutes * total) / bp.total_questions))) : bp.total_minutes;
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
        ...(sectional ? {} : { whole_test_minutes: wholeMinutes }),
        exam_blueprint: { id: bp.id, edition: bp.edition, verification_status: bp.verification_status },
      },
    },
    createdByUserId,
  );
  return { assessment, warnings };
}
