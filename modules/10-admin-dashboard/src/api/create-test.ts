// CT-2: "Create a test" (POST /api/admin/tests, module 05 compileTestSpec). Always a DRAFT.
import { adminApi } from "../api.js";

export type CreateTestCover =
  | { kind: "whole"; question_count: number }
  | { kind: "topics"; topics: Array<{ node_id: string; count: number }> }
  | { kind: "pattern"; blueprint_id: string; section_positions?: number[]; scale_percent?: number; question_count?: number };

export interface CreateTestBody {
  pack_id: string;
  level_id: string;
  name: string;
  cover: CreateTestCover;
  minutes?: number;
  difficulty_min?: number;
  difficulty_max?: number;
  delivery_mode: "mock" | "real";
  camera_required?: boolean;
  opens_at: string;
  closes_at?: string | null;
  settings?: { integrity?: { fullscreen: boolean; block_copy_paste: boolean }; feedback_level?: string };
}

export async function createTestApi(body: CreateTestBody): Promise<{ assessment: { id: string }; warnings: string[] }> {
  return adminApi<{ assessment: { id: string }; warnings: string[] }>("/admin/tests", { method: "POST", body: JSON.stringify(body) });
}
