// X6b - per-question analytics for one assessment (read only).
// Route: GET /admin/assessments/:id/question-analytics. Literal paths only (lint:ui-api-contract).
import { adminApi } from "../api.js";

export interface QuestionAnalyticsItem {
  question_id: string;
  pack_id: string;
  position: number;
  type: string;
  stem_preview: string;
  attempts: number;
  correct_count: number;
  share_correct: number | null;
  avg_time_seconds: number | null;
  distractors?: Array<{ option_index: number; count: number }>;
  possibly_bad: boolean;
  flag_reason: string | null;
}

export async function getQuestionAnalyticsApi(assessmentId: string): Promise<QuestionAnalyticsItem[]> {
  const r = await adminApi<{ items: QuestionAnalyticsItem[] }>(`/admin/assessments/${assessmentId}/question-analytics`);
  return r.items;
}
