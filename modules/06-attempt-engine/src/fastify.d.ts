// Ambient FastifyRequest augmentation — kept byte-identical with
// modules/01-auth, modules/04-question-bank, modules/05-assessment-lifecycle.
// See modules/05-assessment-lifecycle/src/fastify.d.ts for the full rationale.

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
