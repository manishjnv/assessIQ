// EXP-6 tail: exam blueprint read page and "Start full mock" (super admin). Kept out of src/api.ts.
// Routes: GET /api/admin/blueprints (full list with sections), POST /api/admin/blueprints/:id/mock (module 05).
import { adminApi } from "../api.js";

export interface BlueprintSection {
  position: number;
  name: string;
  subject_node_id: string | null;
  question_count: number;
  marks_per_question: number;
  negative_marks_per_question: number;
  minutes: number | null;
  sectional_timing: boolean;
  qualifying: boolean;
  cutoff_marks: number | null;
  calculator_allowed: boolean;
  allowed_types: string[];
}

export interface ExamBlueprintFull {
  id: string;
  stage_node_id: string | null;
  edition: string;
  name: string;
  total_minutes: number;
  qualifying: boolean;
  verification_status: "verified" | "unverified";
  source_note: string | null;
  total_questions: number;
  total_marks: number;
  sections: BlueprintSection[];
}

/** GET /api/admin/blueprints — every exam blueprint, each with its sections. */
export async function listExamBlueprintsFullApi(): Promise<{ items: ExamBlueprintFull[] }> {
  return adminApi<{ items: ExamBlueprintFull[] }>("/admin/blueprints");
}

export interface FullMockInput {
  pack_id: string;
  level_id: string;
  opens_at: string;
  closes_at?: string | null;
  name?: string;
}

/** POST /api/admin/blueprints/:id/mock — a DRAFT full mock. Nothing is sent to candidates. */
export async function startFullMockApi(
  blueprintId: string,
  body: FullMockInput,
): Promise<{ assessment: { id: string }; warnings: string[] }> {
  return adminApi<{ assessment: { id: string }; warnings: string[] }>(
    `/admin/blueprints/${encodeURIComponent(blueprintId)}/mock`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
