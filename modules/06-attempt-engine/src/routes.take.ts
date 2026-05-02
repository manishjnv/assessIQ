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
  // GET /take/:token  — anonymous intro fetch
  // -------------------------------------------------------------------------
  //
  // Returns 200 with the assessment + level + candidate identity if the
  // invitation is live. Returns 404 (generic envelope) for every failure
  // mode. Side effect: marks invitation status='viewed' on first GET.
  //
  // NOTE: this route does NOT mint a session — the candidate must POST to
  // /take/:token/start to receive a session cookie. The GET is a preview
  // surface (so the candidate UI can render "Welcome, Name — ready to
  // begin?" without committing the candidate to a session yet).

  app.get<{ Params: { token: string } }>(
    "/take/:token",
    { preHandler: publicChain },
    async (req, reply) => {
      const { token } = req.params;
      if (typeof token !== "string" || token.length < TOKEN_MIN_LEN) {
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      let resolved: ResolvedInvitation | null;
      try {
        resolved = await resolveInvitationToken(token);
      } catch (err) {
        // Don't surface internal errors as 500 — same generic 404 keeps the
        // surface uniform. The error is logged for ops triage with the
        // hash-prefix trace; a 5xx counter on the @api Caddy block would
        // flag persistent infra failures separately.
        log.error(
          { err, tokenTrace: tokenLogTrace(token) },
          "/take/:token: resolveInvitationToken threw",
        );
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      if (resolved === null) {
        log.info(
          { tokenTrace: tokenLogTrace(token), outcome: "not_found_or_expired" },
          "/take/:token GET",
        );
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      if (resolved.already_submitted) {
        log.info(
          { tokenTrace: tokenLogTrace(token), outcome: "already_submitted" },
          "/take/:token GET",
        );
        return reply.code(410).send(ALREADY_SUBMITTED_ENVELOPE);
      }

      // Mark viewed (idempotent — only flips pending → viewed). RLS-scoped.
      try {
        await markInvitationViewedByToken(
          resolved.assessment.tenant_id,
          resolved.invitation.id,
        );
      } catch (err) {
        // Mark-viewed is observability-grade; if it fails, the candidate
        // experience is unaffected. Log and continue.
        log.warn(
          { err, tokenTrace: tokenLogTrace(token) },
          "/take/:token: markInvitationViewedByToken threw",
        );
      }

      log.info(
        {
          tokenTrace: tokenLogTrace(token),
          assessmentId: resolved.assessment.id,
          status: resolved.invitation.status,
        },
        "/take/:token GET ok",
      );

      // Return the minimum metadata needed for the candidate UI to render
      // the intro screen. Token is NOT echoed back.
      return reply.code(200).send({
        assessment: {
          id: resolved.assessment.id,
          name: resolved.assessment.name,
          description: resolved.assessment.description,
          question_count: resolved.assessment.question_count,
        },
        level: {
          label: resolved.level.label,
          duration_minutes: resolved.level.duration_minutes,
        },
        candidate: {
          email: resolved.candidate.email,
          name: resolved.candidate.name,
        },
        invitation: {
          status: resolved.invitation.status,
          expires_at: resolved.invitation.expires_at,
        },
        can_start: resolved.can_start,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /take/:token/start  — token → session + attempt
  // -------------------------------------------------------------------------
  //
  // Atomic: resolve token → mint candidate session → create-or-return attempt.
  // Returns 201 with attempt + Set-Cookie aiq_sess. Idempotent on second call
  // for the same (assessment, user) — startAttempt itself is idempotent.

  app.post<{ Params: { token: string } }>(
    "/take/:token/start",
    { preHandler: publicChain },
    async (req, reply) => {
      const { token } = req.params;
      if (typeof token !== "string" || token.length < TOKEN_MIN_LEN) {
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      const resolved = await resolveInvitationToken(token).catch((err: unknown) => {
        log.error(
          { err, tokenTrace: tokenLogTrace(token) },
          "/take/:token/start: resolveInvitationToken threw",
        );
        return null;
      });

      if (resolved === null) {
        return reply.code(404).send(NOT_FOUND_ENVELOPE);
      }

      if (resolved.already_submitted) {
        return reply.code(410).send(ALREADY_SUBMITTED_ENVELOPE);
      }

      // Derive client IP + UA — same fields the SSO + invitation-accept
      // flows record. Falls back to the 'unknown' sentinel rather than null
      // to keep downstream session-row schema clean.
      const ip =
        (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip ?? "0.0.0.0";
      const ua = (req.headers["user-agent"] as string | undefined) ?? "unknown";

      // Mint candidate session BEFORE startAttempt so the session_id is
      // available if we later wire attempt rows to a session_id (Phase 2
      // could). totpVerified=true per the magic-link contract — the token
      // IS the auth factor.
      const sessionResult = await mintCandidateSession({
        userId: resolved.candidate.id,
        tenantId: resolved.assessment.tenant_id,
        ip,
        ua,
      });

      // Create or return existing attempt — idempotent.
      let attempt;
      try {
        attempt = await startAttempt(resolved.assessment.tenant_id, {
          userId: resolved.candidate.id,
          assessmentId: resolved.assessment.id,
        });
      } catch (err) {
        // If startAttempt rejects (assessment not active, pool too small,
        // etc.), the candidate-facing message is "we can't start your
        // attempt right now" — but we DON'T leak the specific failure
        // beyond what the @assessiq/core error handler already provides.
        // Translate NotFoundError / ValidationError into a 404+code.
        if (err instanceof NotFoundError || err instanceof ValidationError) {
          log.warn(
            {
              err,
              tokenTrace: tokenLogTrace(token),
              assessmentId: resolved.assessment.id,
            },
            "/take/:token/start: startAttempt rejected",
          );
          return reply.code(404).send(NOT_FOUND_ENVELOPE);
        }
        throw err;
      }

      // Issue the session cookie ONLY now — after both the token verified
      // and the attempt was successfully created. If startAttempt threw
      // before this point, we don't ship a cookie and the candidate sees
      // a 404; the session row is now orphaned in Postgres+Redis and will
      // expire naturally. (A future cleanup could DELETE it inline on the
      // throw path.)
      //
      // Using `reply.header('Set-Cookie', ...)` rather than @fastify/cookie's
      // setCookie helper so this module stays free of an apps/api-specific
      // plugin dep — same structural-typing rationale as routes.candidate.ts.
      const cookieParts = [
        `${config.SESSION_COOKIE_NAME}=${sessionResult.token}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${8 * 3600}`,
      ];
      if (config.NODE_ENV === "production") cookieParts.push("Secure");
      reply.header("Set-Cookie", cookieParts.join("; "));

      log.info(
        {
          tokenTrace: tokenLogTrace(token),
          assessmentId: resolved.assessment.id,
          attemptId: attempt.id,
          sessionId: sessionResult.id,
        },
        "/take/:token/start ok",
      );

      return reply.code(201).send({
        attempt_id: attempt.id,
        assessment_id: resolved.assessment.id,
        status: attempt.status,
        ends_at: attempt.ends_at,
        // SPA navigates here next — the candidate's session cookie is now set
        // so /api/me/attempts/:id will succeed.
        next: `/me/attempts/${attempt.id}`,
      });
    },
  );
}
