/**
 * Public (anonymous) help routes.
 *
 * GET /help/:key  — no auth required. Used by embed candidate UI.
 * Returns globals only (no tenant context set — see service.withGlobalsOnly).
 */

import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError } from "@assessiq/core";
import { getHelpKey } from "./service.js";

// Matches help_id segments: lowercase letters, digits, underscores, dots.
const HELP_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
// Matches BCP-47 short locales: 'en', 'hi', 'hi-IN', 'kn-IN', etc.
const LOCALE_RE = /^\w{2,3}(-[A-Z]{2})?$/;

export async function registerHelpPublicRoutes(app: FastifyInstance): Promise<void> {
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
