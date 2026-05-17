// Ambient types: pulls in the FastifyRequest augmentation that 01-auth
// declares (modules/01-auth/src/types.d.ts) so routes.ts here can read
// `req.session?.tenantId` without TS complaining.
//
// Byte-identical to modules/05-assessment-lifecycle/src/fastify.d.ts —
// keep in sync with that file and 04-question-bank/src/fastify.d.ts.
// See modules/01-auth/SKILL.md § Decisions captured § 9 for source of truth.

declare module "fastify" {
  interface FastifyRequest {
    session?: {
      id: string;
      userId: string;
      tenantId: string;
      role: "admin" | "super_admin" | "reviewer" | "candidate";
      totpVerified: boolean;
      expiresAt: string;
      lastSeenAt: string;
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
