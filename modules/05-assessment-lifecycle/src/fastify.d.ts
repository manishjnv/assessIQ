// Ambient types: pulls in the FastifyRequest augmentation that 01-auth
// declares (modules/01-auth/src/types.d.ts) so routes.ts here can read
// `req.session?.tenantId` / `req.session?.userId` without TS complaining.
//
// Same drift pattern as modules/04-question-bank/src/fastify.d.ts — keep this
// declaration BYTE-IDENTICAL with 04's session/apiKey shape so library code
// in either module compiles against the same merged type. apps/api/src/
// types.d.ts adds request-scoped state (assessiqCtx, tenant, db) that is NOT
// duplicated here — that's apps/api territory.
//
// If you're adding a field to FastifyRequest:
//   library code → add here AND in 01-auth + 04-question-bank (keep in sync)
//   server hook code → add only in apps/api/src/types.d.ts
//
// Source of truth for the session/apiKey field set:
// modules/01-auth/SKILL.md § Decisions captured § 9.

declare module "fastify" {
  interface FastifyRequest {
    session?: {
      id: string;
      userId: string;
      tenantId: string;
      role: "admin" | "reviewer" | "candidate";
      totpVerified: boolean;
      expiresAt: string;
      lastTotpAt: string | null;
    };
    apiKey?: {
      id: string;
      tenantId: string;
      scopes: string[];
    };
  }
}

export {};
