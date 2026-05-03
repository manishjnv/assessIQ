/**
 * Handlers: GET /admin/grading/jobs  and  POST /admin/grading/jobs/:id/retry
 *
 * Phase 2 G2.A Session 1.b — service-layer handlers (no Fastify req/reply).
 *
 * Decision references:
 *   D3 — Phase 1 has no grading_jobs table. These handlers are forward-compat
 *        stubs for anthropic-api mode (Phase 2), which will add a grading_jobs
 *        BullMQ state machine (pending → in_progress → done | failed).
 *
 * In claude-code-vps mode:
 *   - listGradingJobs always returns an empty list. There are no async jobs;
 *     grading is synchronous admin-on-click (D7 single-flight).
 *   - retryGradingJob always throws RUNTIME_NOT_IMPLEMENTED 503. The admin
 *     re-triggers via the "Re-run" button which hits handleAdminRerun.
 *
 * When Phase 2 ships anthropic-api mode, these stubs will be replaced with
 * real BullMQ queue reads. The empty-list / 503 contract lets the admin UI
 * ship now and conditionally render the jobs panel only in anthropic-api mode.
 */

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminListGradingJobsInput {
  tenantId: string;
  userId: string;
}

export interface HandleAdminListGradingJobsOutput {
  /** Always empty in claude-code-vps mode (D3 — no grading_jobs table). */
  items: never[];
}

export interface HandleAdminRetryGradingJobInput {
  tenantId: string;
  userId: string;
  jobId: string;
  sessionLastActivity: Date | null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List grading jobs. Always returns empty in claude-code-vps mode.
 *
 * Phase 2 (anthropic-api): replace body with a BullMQ queue inspection query
 * against the grading_jobs table or directly via BullMQ's getJobs() API.
 */
export async function handleAdminListGradingJobs(
  _input: HandleAdminListGradingJobsInput,
): Promise<HandleAdminListGradingJobsOutput> {
  // D3: no grading_jobs in Phase 1 / claude-code-vps mode.
  // Return empty list so the admin UI can render "no jobs" rather than error.
  return { items: [] };
}

/**
 * Retry a grading job by ID. Always throws 503 in claude-code-vps mode.
 *
 * Phase 2 (anthropic-api): replace body with a BullMQ job.retry() call
 * after looking up the job by ID in the grading_jobs table.
 *
 * In Phase 1, admins re-trigger via POST /admin/attempts/:id/rerun
 * (handleAdminRerun), not via a job ID.
 */
export async function handleAdminRetryGradingJob(
  _input: HandleAdminRetryGradingJobInput,
): Promise<never> {
  throw new AppError(
    "Grading job retry is not available in claude-code-vps mode. " +
      "Use POST /admin/attempts/:id/rerun to re-trigger grading.",
    AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
    503,
  );
}
