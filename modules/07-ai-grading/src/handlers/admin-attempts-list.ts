/**
 * Handler: GET /api/admin/attempts
 *
 * Service-layer handler (no Fastify req/reply). Returns the tenant-scoped,
 * paged, optionally status-filtered list of attempts for the admin dashboard.
 *
 * RLS: withTenant() scopes to current tenant. listAttemptsForAdmin does NOT
 * add WHERE tenant_id — RLS on attempts enforces isolation (CLAUDE.md hard
 * rule #4; same rationale as admin-queue.ts).
 *
 * `userId` is carried in the input signature for audit/log future use — it is
 * not used in the query (admin can see all attempts in their tenant).
 */

import { withTenant } from "@assessiq/tenancy";
import { listAttemptsForAdmin } from "../repository.js";
import type { AttemptListRow } from "../repository.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminListAttemptsInput {
  tenantId: string;
  userId: string;
  limit: number;
  offset: number;
  status?: string;
}

export interface HandleAdminListAttemptsOutput {
  items: AttemptListRow[];
  total: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminListAttempts(
  input: HandleAdminListAttemptsInput,
): Promise<HandleAdminListAttemptsOutput> {
  const { tenantId, limit, offset } = input;
  // exactOptionalPropertyTypes: only spread status when defined so we don't
  // pass `{ status: undefined }` where listAttemptsForAdmin expects `status?: string`.
  const repoOpts: { limit: number; offset: number; status?: string } = {
    limit,
    offset,
  };
  if (input.status !== undefined) repoOpts.status = input.status;
  return withTenant(tenantId, (client) => listAttemptsForAdmin(client, repoOpts));
}
