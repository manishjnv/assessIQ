// Ambient FastifyRequest augmentation — kept byte-identical with
// modules/01-auth, modules/04-question-bank, modules/05-assessment-lifecycle,
// modules/06-attempt-engine, except that this module additionally exposes
// `lastSeenAt` on the session shape.
//
// `lastSeenAt` is the canonical heartbeat field (updated by extendOnPass on
// every authenticated request via modules/01-auth/src/sessions.ts `refreshSession`).
// The admin-grade handler reads it to enforce the 60s heartbeat invariant
// (D2 + D7 from modules/07-ai-grading/SKILL.md): if lastSeenAt > 60s ago,
// the session is considered stale and grading is rejected with HEARTBEAT_STALE.
//
// This field is added to the apps/api/src/types.d.ts Pick<Session, ...> in the
// same PR — see the comment in that file. Keep this shape in sync with
// modules/01-auth/src/sessions.ts Session interface.
//
// If you're adding a field to FastifyRequest:
//   library code → add here AND in 04-question-bank, 05-assessment-lifecycle,
//                  06-attempt-engine (keep in sync)
//   server hook code → add only in apps/api/src/types.d.ts

declare module "fastify" {
  interface FastifyRequest {
    session?: {
      id: string;
      userId: string;
      tenantId: string;
      role: "admin" | "reviewer" | "candidate";
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
