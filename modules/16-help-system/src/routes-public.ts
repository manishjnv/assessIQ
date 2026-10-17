/**
 * Public (anonymous) help routes.
 *
 * GET /help/:key  — no auth required. Used by embed candidate UI.
 * Returns globals only (no tenant context set — see service.withGlobalsOnly).
 */

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { NotFoundError, ValidationError } from "@assessiq/core";
import { getHelpForPage, getHelpKey } from "./service.js";

/**
 * Injected by apps/api (this package must not import 01-auth). The anonymous
 * page-batch route registers ONLY when a rate limiter is supplied (fail-closed).
 */
export interface HelpPublicDeps {
  rateLimit?: preHandlerHookHandler | preHandlerHookHandler[];
}

// Anonymous page-batch allowlist: exact match, no wildcards. Each page maps to
// keys '<page>.%' only. Audience is fixed server-side to candidate (+ 'all' rows
// via the SQL); admin rows can never match. Do not widen without a security review.
const PUBLIC_BATCH_PAGES: ReadonlySet<string> = new Set(["candidate.take", "candidate.attempt"]);

// Matches help_id segments: lowercase letters, digits, underscores, dots.
const HELP_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
// Matches BCP-47 short locales: 'en', 'hi', 'hi-IN', 'kn-IN', etc.
const LOCALE_RE = /^\w{2,3}(-[A-Z]{2})?$/;

export async function registerHelpPublicRoutes(
  app: FastifyInstance,
  deps: HelpPublicDeps = {},
): Promise<void> {
  // GET /api/help/public?page=<candidate.take|candidate.attempt>&locale=en — anonymous token-landing
  // help. Globals only (tenant_id IS NULL via withGlobalsOnly + RLS); no tenant
  // overrides, no admin audience, no cookies. Separate path from the
  // authenticated GET /api/help (Fastify allows one handler per method+path).
  if (deps.rateLimit !== undefined) {
    app.get("/api/help/public", { preHandler: deps.rateLimit }, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const page = q["page"];
      const locale = q["locale"] ?? "en";
      if (page === undefined || !PUBLIC_BATCH_PAGES.has(page)) {
        throw new ValidationError("Page not available to anonymous callers", {
          details: { code: "INVALID_PARAM", param: "page" },
        });
      }
      if (!LOCALE_RE.test(locale)) {
        throw new ValidationError("Invalid locale format", {
          details: { code: "INVALID_PARAM", param: "locale" },
        });
      }
      const rows = await getHelpForPage(null, page, "candidate", locale);
      void reply.header("Cache-Control", "public, max-age=60");
      return rows;
    });
  }

  // NOTE: no preHandler — this route is intentionally anonymous.
  // The global tenantContextMiddleware in server.ts is gated on
  // `req.session?.tenantId` being present, so it is a no-op here.
  app.get("/help/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const q = req.query as Record<string, string | undefined>;
    const locale = q["locale"] ?? "en";

    if (!HELP_KEY_RE.test(key)) {
      throw new ValidationError("Invalid help key format", {
        details: { code: "INVALID_PARAM", param: "key" },
      });
    }
    if (!LOCALE_RE.test(locale)) {
      throw new ValidationError("Invalid locale format", {
        details: { code: "INVALID_PARAM", param: "locale" },
      });
    }

    const entry = await getHelpKey(null, key, locale);
    if (entry === null) {
      throw new NotFoundError(`Help entry not found: ${key}`);
    }
    return reply.send(entry);
  });
}
