// Ambient types: pulls in the FastifyRequest augmentation that 01-auth
// declares (modules/01-auth/src/types.d.ts) so routes.ts here can read
// `req.session?.tenantId` / `req.session?.userId` without TS complaining.
//
// Same pattern as modules/01-auth — a declare-module block only takes effect
// when the downstream tsconfig actually includes the file. Local re-declare
// keeps the question-bank tsconfig (`include: ["src/**/*"]`) self-contained
// without forcing a path reference into another module.
//
// THREE DECLARATION FILES, INTENTIONAL DRIFT — read this carefully before
// "syncing" anything:
//   modules/01-auth/src/types.d.ts          → { session?, apiKey? }
//   modules/04-question-bank/src/fastify.d.ts (this file) → { session?, apiKey? }
//   apps/api/src/types.d.ts                  → { session?, apiKey?, assessiqCtx, tenant?, db? }
//
// TypeScript module-augmentation merges all three when they're in the same
// compilation unit. The 01-auth and question-bank files keep their shape
// MINIMAL — just session + apiKey — because their library code only reads
// those two. The apps/api file ADDS request-scoped state (assessiqCtx for
// log-mixin correlation, tenant for the post-tenant-context handle, db for
// the per-request PoolClient) that ONLY the apps/api server hooks touch.
//
// If you're adding a field to FastifyRequest, decide which compilation unit
// uses it: library code → add here AND in 01-auth (keep them byte-identical
// for session/apiKey shape). Server hook code → add only in apps/api/src/
// types.d.ts. Adding here just to "match" apps/api would force a Pool / pg
// dep into the question-bank package — which is exactly what this file is
// designed to avoid.
//
// Source of truth for the session/apiKey field set: modules/01-auth/SKILL.md
// § Decisions captured § 9.

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
