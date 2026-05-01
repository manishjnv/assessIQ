// Ambient types: extends fastify's FastifyRequest with the session and apiKey
// decorations set by 01-auth/src/middleware/{sessionLoader,apiKeyAuth}.
//
// Per modules/01-auth/SKILL.md § Decisions captured § 9, the field name is
// `tenantId` (lowerCamelCase) — 02-tenancy.tenantContextMiddleware reads
// `req.session?.tenantId ?? req.apiKey?.tenantId`.
//
// Phase 0: 01-auth does NOT depend on `fastify` (the Fastify server scaffold
// lands later in the phase). The declaration is wrapped in a module-augment
// guard so the file type-checks even before `fastify` is installed: the
// `declare module` only takes effect when fastify's types are present in the
// downstream consumer.

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
