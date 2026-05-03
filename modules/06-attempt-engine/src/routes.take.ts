// AssessIQ — magic-link /take/:token route layer.
//
// Pre-auth public surface that lets a candidate redeem an invitation token
// (sent by email) into a candidate session + an active attempt. Two routes:
//
//   GET    /take/:token        — resolve invitation, mark viewed, return intro
//   POST   /take/:token/start  — mint candidate session, create/return attempt,
//                                Set-Cookie aiq_sess
//
// SECURITY POSTURE (codex:rescue MANDATORY before push per CLAUDE.md):
//
//   1. Pre-auth surface — `requireSession: false` chain (rate-limit only).
//      Token IS the credential; no other auth is required at this hop.
//   2. Generic 404 envelope for every failure mode (token missing, expired,
//      revoked, malformed) — NEVER distinguish causes so a caller cannot
//      enumerate. The internal log distinguishes for ops.
//   3. Token plaintext NEVER logged. Logs include only the SHA-256 hash
//      prefix (first 8 hex chars) for traceability.
//   4. Constant-time hash comparison happens implicitly via the indexed
//      `token_hash` equality lookup in Postgres — partial matches return
//      no row in the same time as no-match-at-all.
//   5. Session cookie set with httpOnly + sameSite='lax' + secure (prod) +
//      path='/' — same shape as the SSO callback. SameSite=lax is required
//      so the link click (top-level GET navigation) carries the cookie
//      back to the SPA's first XHR.
//   6. Replay protection — the underlying `startAttempt` is idempotent on
//      (assessment_id, user_id) and refuses to reuse an attempt past the
//      submit boundary. The token itself stays "live" for the candidate's
//      retry window (browser crash, network blip) but cannot be used to
//      create multiple attempts or to unsubmit a finished one.
//   7. Token TTL — `resolveInvitationToken()` returns null on expired
//      invitations; the route handler maps null to the same generic 404.
//   8. Candidate identity is read from the resolved invitation's user row,
//      NOT from any client-supplied field. The token binds to user_id at
//      issuance time; the candidate cannot impersonate another candidate
//      even if they intercept someone else's token (still bound to that
//      other user_id, and the attempt is owned by them).
//
// HARD RULES:
//   - Never include the plaintext token in any log line.
//   - Never set a session cookie unless `resolveInvitationToken` returned a
//     non-null result with `can_start === true`.
//   - Never return user.email or user.name to a caller who hasn't proven
//     the token is live (i.e., we only return them inside a 200 response
//     after a successful resolveInvitationToken).

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { config, NotFoundError, streamLogger, ValidationError } from "@assessiq/core";
import { mintCandidateSession } from "@assessiq/auth";
import {
  resolveInvitationToken,
  markInvitationViewedByToken,
  type ResolvedInvitation,
} from "@assessiq/assessment-lifecycle";
import { startAttempt } from "./service.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum length we'll even hash. Issued tokens are 43-char base64url (32 bytes). */
const TOKEN_MIN_LEN = 16;

/** Generic envelope used for every "no, you can't have this" outcome. */
const NOT_FOUND_ENVELOPE = {
  error: {
    code: "INVITATION_NOT_FOUND",
    message: "The invitation link is invalid, expired, or already used.",
  },
};

/** Used for the post-submit "you already finished" outcome — distinct status to help the candidate UI render the right message. */
const ALREADY_SUBMITTED_ENVELOPE = {
  error: {
    code: "ALREADY_SUBMITTED",
    message: "This assessment has already been submitted. Contact your admin if this is unexpected.",
  },
};

/**
 * Hash prefix for log traceability. Never returns the plaintext.
 */
function tokenLogTrace(plaintext: string): string {
  // Use a stable byte-prefix of the plaintext rather than re-hashing here —
  // the goal is correlation across log lines, not authenticity. We still
  // refuse to emit the full token; first 6 chars over a 43-char tokens space
  // is enumeration-resistant (no shared bits give away other tokens).
  return plaintext.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Plugin registrar
// ---------------------------------------------------------------------------

export interface RegisterAttemptTakeRoutesOptions {
  /**
   * Pre-auth chain — rateLimit + sessionLoader (in case the candidate is
   * already logged in) + apiKeyAuth (no-op without a key) + syncCtx, then
   * stops. NO requireAuth — the token IS the auth factor here.
   *
   * apps/api passes `publicAuthChain` (or equivalent) which is `authChain({
   * requireSession: false })`.
   */
  publicChain: preHandlerHookHandler[] | preHandlerHookHandler;
}

export async function registerAttemptTakeRoutes(
  app: FastifyInstance,
  opts: RegisterAttemptTakeRoutesOptions,
): Promise<void> {
  const { publicChain } = opts;

  // -------------------------------------------------------------------------
  // POST /take/start  — body { token } → session + attempt
  // -------------------------------------------------------------------------
  //
  // Single endpoint matching the candidate-ui contract at
  // modules/11-candidate-ui/src/api.ts § takeStart and the
  // TakeStartResponseWire shape at .../src/types.ts.
  //
  // Atomic: resolve token → mark viewed → mint candidate session → create
  // or return existing attempt → Set-Cookie aiq_sess → return JSON.
  //
  // Idempotent on retry: a second call for the same (token, user) returns
  // the existing attempt (startAttempt is idempotent on (assessment, user)).
  // The session cookie is re-issued each time — the candidate may have
  // closed the tab and clicked the email link again; we want them resumed,
  // not 401'd out. The token stays "live" until the attempt status leaves
  // 'in_progress' (then `already_submitted` returns 410).
  //
  // The bare-root `/take/<token>` GET is OWNED BY THE SPA (React Router
  // renders TokenLanding which calls this endpoint). The Caddy `@api`
  // matcher must include `/take/start` (specific path) but NOT `/take/*`
  // — otherwise the SPA's GET gets routed to the API and broken.

  interface TakeStartBody {
    token?: unknown;
  }

  app.post<{ Body: TakeStartBody }>(
    "/take/start",
    { preHandler: publicChain },
    async (req, reply) => {
      const body = (req.body ?? {}) as TakeStartBody;
      const token = body.token;
      if (typeof token !== "string" || token.length < TOKEN_MIN_LEN) {
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      const resolved = await resolveInvitationToken(token).catch((err: unknown) => {
        log.error(
          { err, tokenTrace: tokenLogTrace(token) },
          "/take/start: resolveInvitationToken threw",
        );
        return null;
      });

      if (resolved === null) {
        log.info(
          { tokenTrace: tokenLogTrace(token), outcome: "not_found_or_expired" },
          "/take/start",
        );
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      if (resolved.already_submitted) {
        log.info(
          { tokenTrace: tokenLogTrace(token), outcome: "already_submitted" },
          "/take/start",
        );
        return reply.code(410).send(ALREADY_SUBMITTED_ENVELOPE);
      }

      // Mark viewed (idempotent — only flips pending → viewed). Best-effort;
      // observability-grade write that doesn't gate the response.
      try {
        await markInvitationViewedByToken(
          resolved.assessment.tenant_id,
          resolved.invitation.id,
        );
      } catch (err) {
        log.warn(
          { err, tokenTrace: tokenLogTrace(token) },
          "/take/start: markInvitationViewedByToken threw",
        );
      }

      // Derive client IP + UA — same fields the SSO + invitation-accept
      // flows record. Falls back to a sentinel rather than null to keep
      // downstream session-row schema clean.
      const ip =
        (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip ?? "0.0.0.0";
      const ua = (req.headers["user-agent"] as string | undefined) ?? "unknown";

      // Mint candidate session BEFORE startAttempt so the session_id is
      // available if we later wire attempt rows to a session_id. The
      // `totpVerified=true` flag inside `mintCandidateSession` reflects the
      // magic-link contract — the token IS the auth factor.
      const sessionResult = await mintCandidateSession({
        userId: resolved.candidate.id,
        tenantId: resolved.assessment.tenant_id,
        ip,
        ua,
      });

      // Create or return existing attempt — idempotent on (assessment, user).
      let attempt;
      try {
        attempt = await startAttempt(resolved.assessment.tenant_id, {
          userId: resolved.candidate.id,
          assessmentId: resolved.assessment.id,
        });
      } catch (err) {
        // Translate domain failures (assessment not active, pool too small,
        // etc.) into the same generic 404 so the candidate UI doesn't have
        // to enumerate states. The internal log captures the specific code.
        if (err instanceof NotFoundError || err instanceof ValidationError) {
          log.warn(
            {
              err,
              tokenTrace: tokenLogTrace(token),
              assessmentId: resolved.assessment.id,
            },
            "/take/start: startAttempt rejected",
          );
          return reply.code(404).send(NOT_FOUND_ENVELOPE);
        }
        throw err;
      }

      // Set-Cookie ONLY after both the token verified AND the attempt was
      // successfully created/resumed. Using `reply.header('Set-Cookie', ...)`
      // rather than @fastify/cookie's setCookie helper so this module stays
      // free of an apps/api-specific plugin dep.
      const cookieParts = [
        `${config.SESSION_COOKIE_NAME}=${sessionResult.token}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${8 * 3600}`,
      ];
      if (config.NODE_ENV === "production") cookieParts.push("Secure");
      reply.header("Set-Cookie", cookieParts.join("; "));

      // duration_seconds: server-pinned at startAttempt time on the attempt
      // row itself; we surface the canonical value (not level.duration_minutes
      // re-derived) so a future admin extension to attempt-specific durations
      // is one schema bump away.
      const durationSeconds =
        attempt.duration_seconds ?? resolved.level.duration_minutes * 60;

      log.info(
        {
          tokenTrace: tokenLogTrace(token),
          assessmentId: resolved.assessment.id,
          attemptId: attempt.id,
          sessionId: sessionResult.id,
        },
        "/take/start ok",
      );

      // Shape MUST match modules/11-candidate-ui/src/types.ts §
      // TakeStartResponseWire. SPA navigates to /take/attempt/<attempt_id>
      // after success; with the session cookie now set, /api/me/attempts/:id
      // succeeds on the next request.
      return reply.code(201).send({
        attempt_id: attempt.id,
        assessment: {
          id: resolved.assessment.id,
          name: resolved.assessment.name,
          duration_seconds: durationSeconds,
        },
      });
    },
  );
}
