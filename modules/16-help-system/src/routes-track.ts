/**
 * Telemetry tracking route — no auth required (anonymous candidate UI may emit).
 *
 * POST /api/help/track
 *   body: { event: 'tooltip.shown'|'drawer.opened'|'feedback', key: string, thumbsUp?: boolean }
 *   → 204 always (whether sampled or not — never reveal sampling state to client)
 *
 * Server-side sampling: `shouldSampleHelpEvent(key, 0.1)` — ~10% accept rate.
 * The hash is deterministic per key so the same key consistently falls in or
 * out of the sample (long-run rate ≈ 10%). See service.ts for sampler details.
 */

import type { FastifyInstance } from "fastify";
import { ValidationError } from "@assessiq/core";
import { shouldSampleHelpEvent, recordHelpEvent } from "./service.js";

const HELP_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const VALID_EVENTS = new Set(["tooltip.shown", "drawer.opened", "feedback"]);

export async function registerHelpTrackRoutes(app: FastifyInstance): Promise<void> {
  // No preHandler — anonymous candidate UI may emit without a session.
  app.post("/api/help/track", async (req, reply) => {
    const body = req.body as {
      event?: unknown;
      key?: unknown;
      thumbsUp?: unknown;
    };

    if (typeof body.event !== "string" || !VALID_EVENTS.has(body.event)) {
      throw new ValidationError("Invalid or missing 'event'", {
        details: { code: "INVALID_PARAM", param: "event" },
      });
    }
    if (typeof body.key !== "string" || !HELP_KEY_RE.test(body.key)) {
      throw new ValidationError("Invalid or missing 'key'", {
        details: { code: "INVALID_PARAM", param: "key" },
      });
    }

    const event = body.event as "tooltip.shown" | "drawer.opened" | "feedback";
    const key = body.key;

    // Always respond 204 — client must not know whether the event was sampled.
    // Sampling and recording happen fire-and-forget after the reply is sent.
    void reply.code(204).send();

    if (shouldSampleHelpEvent(key, 0.1)) {
      // Extract optional identity context from session if present (may be absent
      // for anonymous candidates). Cast is safe — the auth chain may not have run.
      const session = (req as { session?: { tenantId?: string; userId?: string } }).session;
      const tenantId = session?.tenantId ?? null;
      const userId = session?.userId ?? null;

      // Fire-and-forget. recordHelpEvent is synchronous pino logging so it
      // cannot throw asynchronously; if it ever does, the error is swallowed
      // intentionally (telemetry must never break the response path).
      // exactOptionalPropertyTypes: only include thumbsUp when it is a boolean.
      const trackPayload =
        event === "feedback" && typeof body.thumbsUp === "boolean"
          ? { key, tenantId, userId, thumbsUp: body.thumbsUp }
          : { key, tenantId, userId };

      recordHelpEvent(event, trackPayload).catch(() => {
        // intentionally swallow — telemetry is non-critical
      });
    }
  });
}
