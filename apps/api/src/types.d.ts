import 'fastify';
import type { PoolClient } from 'pg';
import type { Session, ApiKeyRecord } from '@assessiq/auth';

// Fastify request augmentation. The session/apiKey shapes mirror what
// @assessiq/auth's sessionLoaderMiddleware / apiKeyAuthMiddleware populate
// (per modules/01-auth/SKILL.md § Decisions captured § 9). The route layer
// reads these fields; library functions (totp.verify, apiKeys.list,
// sessions.create, etc.) accept tenantId/userId scalars and scope DB queries
// internally via withTenant().
//
// Pick<Session, ...> narrows to the cross-module contract — additional Session
// fields (createdAt, lastSeenAt, ip, ua) are library-internal and not part
// of the request-decoration surface.

declare module 'fastify' {
  // RW-97: `config: { skipAuth: true }` on auth-bypass routes (see middleware/auth-chain.ts).
  // Typed here because @fastify/multipart augments FastifyContextConfig, which turns on
  // excess-property checks for every route config literal.
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
  interface FastifyRequest {
    assessiqCtx: {
      requestId: string;
      tenantId?: string;
      userId?: string;
      ip?: string;
      ua?: string;
    };
    session?: Pick<
      Session,
      'id' | 'userId' | 'tenantId' | 'role' | 'totpVerified' | 'expiresAt' | 'lastSeenAt' | 'lastTotpAt'
    >;
    apiKey?: Pick<ApiKeyRecord, 'id' | 'tenantId' | 'scopes'>;
    tenant?: { id: string };
    db?: PoolClient;
  }
}
