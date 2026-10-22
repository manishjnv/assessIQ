import type { PoolClient } from "pg";

/**
 * Revoking an invitation ends the candidate's running attempt by SUBMITTING and GRADING it (marks already
 * earned are kept), not by discarding it. Module 05 cannot import module 06, so apps/api injects the submit
 * step at boot (same pattern as setCameraRequiredResolver). The function runs inside the revoke transaction.
 * ponytail: module-level slot, not threaded through every service call.
 */
export type RevokeAttemptSubmitter = (client: PoolClient, tenantId: string, attemptId: string) => Promise<void>;

let submitter: RevokeAttemptSubmitter | undefined;

export function setRevokeAttemptSubmitter(fn: RevokeAttemptSubmitter | undefined): void {
  submitter = fn;
}

/** Throws when nothing is registered: a revoke must never leave a running attempt alive without a submit path. */
export function requireRevokeAttemptSubmitter(): RevokeAttemptSubmitter {
  if (submitter === undefined) throw new Error("revoke attempt submitter is not registered (apps/api boot wiring)");
  return submitter;
}
