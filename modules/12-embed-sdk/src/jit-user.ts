// modules/12-embed-sdk/src/jit-user.ts
//
// Just-in-time candidate user resolution for embed flow.
//
// When a host app embeds AssessIQ via JWT, the candidate identified in the JWT
// (email + name + sub) may or may not have an AssessIQ user record yet.
// This module resolves the user: create if absent, return existing if present.
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D1 (JIT user creation).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { withTenant } from "@assessiq/tenancy";
import { uuidv7, AuthzError } from "@assessiq/core";
import type { PoolClient } from "pg";

export interface JitUserInput {
  tenantId: string;
  email: string;       // normalized by the JWT verifier (must equal claim value)
  name: string;
  externalSub: string; // host's user ID (JWT sub claim) — stored in metadata
}

export interface JitUserResult {
  userId: string;
  created: boolean;
}

interface UserRow {
  id: string;
  role: string;
  status: string;
  deleted_at: Date | null;
  erased_at: Date | null;
}

/**
 * Find an existing candidate user by email in this tenant, or create one.
 *
 * The user is always created with role='candidate'. The externalSub is stored
 * in `users.metadata.external_id` so the host's user ID is preserved and flows
 * through webhook payloads via `users.metadata`.
 *
 * An existing row is reused ONLY if it is an active, non-deleted, non-erased
 * candidate. Anything else (admin/reviewer/super_admin with the same email,
 * disabled/pending, soft-deleted, erased) is refused with AuthzError — an embed
 * JWT must never mint a session for a privileged or retired identity. A
 * soft-deleted row still owns the UNIQUE (tenant_id, email) slot, so it cannot
 * be "ignored and recreated"; refusing is the only safe outcome.
 *
 * Note: the users table has no password/TOTP columns — embed candidates auth
 * only via signed JWT.
 */
export async function resolveJitUser(input: JitUserInput): Promise<JitUserResult> {
  const normalizedEmail = input.email.toLowerCase().trim();

  return withTenant(input.tenantId, async (client: PoolClient) => {
    // Case-insensitive: the UNIQUE (tenant_id, email) is case-sensitive TEXT and
    // bootstrap/SQL paths may hold a mixed-case row (e.g. a super_admin seed).
    // Every case variant must pass, or a mixed-case admin could be shadowed by a
    // new lower-case candidate row (codex FR4 HIGH). Exact match is preferred.
    const find = async (): Promise<UserRow | undefined> => {
      const rows = (
        await client.query<UserRow>(
          `SELECT id, role, status, deleted_at, erased_at FROM users
           WHERE tenant_id = $1 AND lower(email) = $2
           ORDER BY (email = $2) DESC`,
          [input.tenantId, normalizedEmail],
        )
      ).rows;
      rows.forEach(assertCandidate);
      return rows[0];
    };

    const existing = await find();
    if (existing !== undefined) return { userId: existing.id, created: false };

    // Not found — create a new candidate user. Only real columns exist on
    // `users`; created_at/updated_at use their DB defaults. ON CONFLICT covers
    // the concurrent double-JIT race (UNIQUE (tenant_id, email)).
    const userId = uuidv7();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (id, tenant_id, email, name, role, status, metadata)
       VALUES ($1, $2, $3, $4, 'candidate', 'active', $5::jsonb)
       ON CONFLICT (tenant_id, email) DO NOTHING
       RETURNING id`,
      [
        userId,
        input.tenantId,
        normalizedEmail,
        input.name,
        JSON.stringify({ external_id: input.externalSub }),
      ],
    );
    if (inserted.rows.length > 0) return { userId, created: true };

    // Lost the race — the winner's row is now committed and visible.
    const winner = await find();
    if (winner === undefined) throw new AuthzError("embed user could not be resolved");
    return { userId: winner.id, created: false };
  });
}

function assertCandidate(u: UserRow): void {
  if (
    u.role !== "candidate" ||
    u.status !== "active" ||
    u.deleted_at !== null ||
    u.erased_at !== null
  ) {
    throw new AuthzError("embed user is not an active candidate");
  }
}
