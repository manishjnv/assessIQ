// AssessIQ - Admin live monitor API client (X6a).
//
// Route: GET /admin/assessments/:id/live-monitor -> LiveMonitorResponse (read only; counts and last seen only).

import { adminApi } from "../api.js";

export interface LiveMonitorRow {
  attempt_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  started_at: string;
  last_seen_at: string;
}

export interface LiveMonitorResponse {
  counts: { invited: number; not_started: number; in_progress: number; submitted: number };
  in_progress: LiveMonitorRow[];
  /** Server clock: "last seen" ages are measured against it, not the browser clock. */
  server_time: string;
}

export async function getLiveMonitorApi(assessmentId: string): Promise<LiveMonitorResponse> {
  return adminApi<LiveMonitorResponse>(`/admin/assessments/${encodeURIComponent(assessmentId)}/live-monitor`);
}
