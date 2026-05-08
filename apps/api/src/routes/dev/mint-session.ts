// AssessIQ — apps/api/src/routes/dev/mint-session.ts
//
// Dev-only POST /api/dev/mint-session.
//
// PURPOSE: Provides a way for Playwright E2E specs to bootstrap a real
// aiq_sess cookie WITHOUT going through Google SSO + TOTP — which cannot be
// automated reliably in CI. The endpoint is intentionally NOT under /api/auth/*
// so it is visually distinct from real auth flows and doesn't inherit the
// auth route rate-limit chain.
//
// SECURITY GATE: This file is only imported (and the route only registered) by
// apps/api/src/server.ts when config.ENABLE_E2E_TEST_MINTER === true. The
// route does NOT exist in the prod module graph at all — it is a conditional
// dynamic import. A runtime check inside the handler would still register the
// route in prod; compile-time skip is stronger.
//
// ANTI-PATTERNS REFUSED:
//   - No NODE_ENV check (use ENABLE_E2E_TEST_MINTER so staging vs dev vs CI
//     configure independently).
//   - No runtime 403 guard (the route must not exist in prod, not just 403).
//   - No cross-tenant session (session tenantId is always derived from the
//     resolved tenant slug — never caller-supplied).
//
// AUDIT: Every successful mint writes an audit_log row with
//   actorKind='system', action='dev.mint_session', entityType='session'.
// This makes dev/staging test runs traceable without exposing real credentials.
//
// MULTI-TENANCY:
//   - tenantSlug is resolved to a real tenant row (system-role lookup, no RLS).
//   - The minted session's tenantId is always the resolved tenant's id.
//   - Users are found-or-created in that tenant only.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance } from 'fastify';
import { config, AuthnError, ValidationError, uuidv7 } from '@assessiq/core';
import { getPool, getTenantBySlug } from '@assessiq/tenancy';
import { sessions } from '@assessiq/auth';
import type { Role } from '@assessiq/auth';
import { audit } from '@assessiq/audit-log';

const ROLE_VALUES = ['admin', 'reviewer', 'candidate'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MintBody {
  email: string;
  role: Role;
  tenantSlug: string;
}

/**
 * Find an existing non-deleted user by (tenant_id, email) using a direct
 * system-role connection (BYPASSRLS). Returns null when no match.
 *
 * Security note: caller has already resolved tenantId from a trusted slug
 * lookup — we are NOT accepting tenantId from the HTTP body.
 */
async function findUserSystemRole(
  tenantId: string,
  email: string,
): Promise<{ id: string; role: string } | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');
    const { rows } = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM users
       WHERE tenant_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL
       LIMIT 1`,
      [tenantId, email],
    );
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a user row for the given tenant using assessiq_system role (BYPASSRLS).
 * Used by the test-minter when no user exists yet for the test email.
 *
 * The created user is immediately 'active' so no invitation flow is needed.
 */
async function createUserSystemRole(
  tenantId: string,
  email: string,
  role: Role,
): Promise<{ id: string }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');
    const id = uuidv7();
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
      [id, tenantId, email, email.split('@')[0] ?? 'Test User', role],
    );
    // Re-query in case the INSERT was a no-op (race with another concurrent
    // insert — return the winner's id).
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL LIMIT 1`,
      [tenantId, email],
    );
    await client.query('COMMIT');
    if (rows[0] === undefined) {
      throw new Error('dev-mint-session: user find-or-create returned no row after INSERT ON CONFLICT');
    }
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export async function registerDevMintSessionRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: MintBody }>(
    '/api/dev/mint-session',
    {
      config: { skipAuth: true },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'role', 'tenantSlug'],
          properties: {
            email: { type: 'string' },
            role: { type: 'string', enum: ROLE_VALUES },
            tenantSlug: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { email, role, tenantSlug } = req.body;

      // Validate inputs at the boundary.
      if (!EMAIL_RE.test(email)) {
        throw new ValidationError('email: invalid format', { details: { code: 'INVALID_EMAIL' } });
      }
      if (!ROLE_VALUES.includes(role)) {
        throw new ValidationError('role: must be admin | reviewer | candidate', {
          details: { code: 'INVALID_ROLE' },
        });
      }

      // Resolve tenant (system-role, no RLS).
      const tenant = await getTenantBySlug(tenantSlug);
      if (tenant === null) {
        throw new AuthnError(`unknown tenant: ${tenantSlug}`);
      }

      // Find or create the user (system-role BYPASSRLS).
      //
      // SECURITY: when an existing user is found, we use the user's CURRENT
      // DB role for the minted session — NEVER the caller-supplied `role`.
      // Otherwise an attacker with mint-endpoint access (staging mis-config)
      // could escalate any existing candidate to admin by passing role:'admin'.
      //
      // SECURITY: when no user exists, refuse to mint admin/reviewer accounts.
      // Privileged accounts must come from the real invitation flow. The
      // minter is for E2E candidate flows + pre-seeded admin fixtures only.
      const existing = await findUserSystemRole(tenant.id, email);
      let userId: string;
      let effectiveRole: Role;
      if (existing !== null) {
        userId = existing.id;
        effectiveRole = existing.role as Role;
      } else {
        if (role !== 'candidate') {
          throw new AuthnError(
            `dev-mint-session: refusing to create new ${role} account; ` +
              `only 'candidate' may be auto-created. Seed admin/reviewer via the real invitation flow.`,
          );
        }
        userId = (await createUserSystemRole(tenant.id, email, role)).id;
        effectiveRole = role;
      }

      // Mint a fully-verified session (totpVerified=true so the spec doesn't
      // need to complete the TOTP flow). The session role is `effectiveRole`,
      // which is the existing user's DB role or — for new users — 'candidate'.
      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip ?? '127.0.0.1';
      const ua = req.headers['user-agent'] ?? 'playwright-e2e';
      const sessionOut = await sessions.create({
        userId,
        tenantId: tenant.id,
        role: effectiveRole,
        totpVerified: true,
        ip,
        ua,
      });

      // Audit — fail-closed. A session-minting endpoint without an audit trail
      // is worse than no endpoint: there's no forensic record of who minted
      // what. If the audit write fails, the request fails too.
      await audit({
        tenantId: tenant.id,
        actorKind: 'system',
        actorUserId: userId,
        action: 'dev.mint_session',
        entityType: 'session',
        entityId: sessionOut.id,
        after: { email, role: effectiveRole, requestedRole: role, tenantSlug },
        ip,
        userAgent: ua,
      });

      // Set the standard session cookie (mirrors what google/cb does).
      const secure = config.NODE_ENV === 'production';
      reply.setCookie(config.SESSION_COOKIE_NAME, sessionOut.token, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });

      reply.code(200).send({ sessionId: sessionOut.id, userId, expiresAt: sessionOut.expiresAt });
    },
  );
}
