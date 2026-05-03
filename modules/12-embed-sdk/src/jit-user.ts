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
import { uuidv7 } from "@assessiq/core";
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
}

/**
 * Find an existing candidate user by email in this tenant, or create one.
 *
 * The user is always created with role='candidate'. The externalSub is stored
 * in `users.metadata.external_id` so the host's user ID is preserved and flows
 * through webhook payloads via `users.metadata`.
 *
 * Note: no password/TOTP is set — embed candidates auth only via signed JWT.
 */
export async function resolveJitUser(input: JitUserInput): Promise<JitUserResult> {
  const normalizedEmail = input.email.toLowerCase().trim();

  return withTenant(input.tenantId, async (client: PoolClient) => {
    // Try to find existing user by email in this tenant.
    const existing = await client.query<UserRow>(
      `SELECT id FROM users
       WHERE tenant_id = $1 AND email = $2
       LIMIT 1`,
      [input.tenantId, normalizedEmail],
    );
    if (existing.rows.length > 0 && existing.rows[0] !== undefined) {
      return { userId: existing.rows[0].id, created: false };
    }

    // Not found — create a new candidate user.
    const userId = uuidv7();
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO users
         (id, tenant_id, email, name, role, status, password_hash, metadata,
          email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'candidate', 'active', NULL,
               $5::jsonb, TRUE, $6, $6)`,
      [
        userId,
        input.tenantId,
        normalizedEmail,
        input.name,
        JSON.stringify({ external_id: input.externalSub }),
        now,
      ],
    );

    return { userId, created: true };
  });
}
