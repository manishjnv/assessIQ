import { config, AuthnError } from '@assessiq/core';
import type { FastifyRequest, FastifyReply } from 'fastify';

const DEV_TENANT_HEADER = 'x-aiq-test-tenant';
const DEV_USER_HEADER = 'x-aiq-test-user-id';
const DEV_ROLE_HEADER = 'x-aiq-test-user-role';

/**
 * FIXME(post-01-auth): replace with the real sessionLoader from 01-auth Window 4.
 * Phase 0 dev-only mock that reads three headers (tenant id, user id, role) and
 * populates req.session. ABSOLUTELY refused in production.
 *
 * The real sessionLoader will:
 *   - read the aiq_sess cookie
 *   - sha256 + Redis lookup
 *   - populate req.session per modules/01-auth/SKILL.md § Decisions captured § 9
 */
export async function devAuthHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Skip auth for routes that opt out via route config (e.g. /api/health, /api/invitations/accept)
  const routeConfig = req.routeOptions?.config as unknown as Record<string, unknown> | undefined;
  if (routeConfig?.['skipAuth'] === true) return;

  if (config.NODE_ENV === 'production') {
    // In production this hook is a hard-fail until 01-auth Window 4 lands.
    // Any route that reaches here without a real session is unauthorized.
    throw new AuthnError(
      'no auth implementation in production yet — 01-auth Window 4 must ship before any /admin/* request can succeed',
    );
  }

  const tenantId = req.headers[DEV_TENANT_HEADER];
  const userId = req.headers[DEV_USER_HEADER];
  const role = req.headers[DEV_ROLE_HEADER];

  if (typeof tenantId !== 'string' || typeof userId !== 'string' || typeof role !== 'string') {
    throw new AuthnError(
      `dev auth requires headers: ${DEV_TENANT_HEADER}, ${DEV_USER_HEADER}, ${DEV_ROLE_HEADER}`,
    );
  }
  if (role !== 'admin' && role !== 'reviewer' && role !== 'candidate') {
    throw new AuthnError(`invalid role in ${DEV_ROLE_HEADER}: ${role}`);
  }

  req.session = { tenantId, userId, role };
  req.assessiqCtx.tenantId = tenantId;
  req.assessiqCtx.userId = userId;
}

export function requireRole(allowed: ReadonlyArray<'admin' | 'reviewer' | 'candidate'>) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const role = req.session?.role;
    if (!role || !allowed.includes(role)) {
      const { AuthzError } = await import('@assessiq/core');
      throw new AuthzError(`role required: one of ${allowed.join(', ')}`);
    }
  };
}
