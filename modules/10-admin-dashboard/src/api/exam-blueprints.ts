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
  /** CT-0: per-pattern question cap, owner contact, archive flag, upkeep dates. */
  max_questions: number;
  owner_contact: string | null;
  archived_at: string | null;
  supersedes_id: string | null;
  last_checked_at: string | null;
  /** YYYY-MM-DD */
  next_check_due: string;
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
  /** EXP-35: 0-based blueprint section positions (subjects). Absent = all sections. */
  section_positions?: number[];
  /** EXP-35: scale every chosen section to this percent, 1 to 100. Absent = full size. */
  scale_percent?: number;
  /** EXP-35: fixed total number of questions (1 to 100), instead of a percent. */
  question_count?: number;
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

/** Body of POST / PUT /api/admin/blueprints (the same shape the server validates). */
export interface BlueprintWriteBody {
  stage_node_id: string | null;
  edition: string;
  name: string;
  total_minutes: number;
  qualifying: boolean;
  verification_status: "verified" | "unverified";
  source_note: string | null;
  max_questions: number;
  owner_contact: string | null;
  sections: Array<Omit<BlueprintSection, "position">>;
}

/** CT-1: PUT a change. A verified edition is never edited: the server adds a NEW edition row and returns it. */
export async function saveBlueprintEditionApi(id: string, body: BlueprintWriteBody): Promise<ExamBlueprintFull> {
  return adminApi<ExamBlueprintFull>(`/admin/blueprints/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
}

/** CT-1: "Mark checked, no change" (POST /api/admin/blueprints/:id/checked). */
export async function markBlueprintCheckedApi(id: string, note: string | null): Promise<ExamBlueprintFull> {
  return adminApi<ExamBlueprintFull>(`/admin/blueprints/${encodeURIComponent(id)}/checked`, { method: "POST", body: JSON.stringify({ note }) });
}

/** CT-1: DELETE archives the pattern (the row and old assessments stay). */
export async function archiveBlueprintApi(id: string): Promise<{ archived: true }> {
  return adminApi<{ archived: true }>(`/admin/blueprints/${encodeURIComponent(id)}`, { method: "DELETE" });
}
