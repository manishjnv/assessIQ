// modules/12-embed-sdk/src/session-mint.ts
//
// Mint an embed session for a verified JWT payload.
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D6, D7.
//
// CRITICAL cookie attributes (frozen D6/D7):
//   - Cookie name:   aiq_embed_sess  (DISTINCT from aiq_sess)
//   - SameSite=None (required for cross-origin iframe context; aiq_sess is Lax)
//   - Secure=true   (mandatory with SameSite=None per RFC 6265bis)
//   - HttpOnly=true (XSS mitigation)
//   - Path=/
//   - Max-Age:       min(JWT exp - now, 8h)  (session hard cap per D6)
//
// Implementation:
//   1. Call sessions.create() from @assessiq/auth — writes to Redis + Postgres.
//      sessions.create() uses the standard aiq:sess:<hash> Redis key.
//   2. Mark the Postgres session row as session_type='embed' (added by 0071 migration).
//   3. Return the session token and cookie-set instructions.
//
// The aiq_embed_sess bridge in apps/api/src/server.ts promotes the embed cookie
// value into the standard session-loader slot for subsequent API calls.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { sessions } from "@assessiq/auth";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";

/** Maximum embed session lifetime — D6 cap. */
const EMBED_SESSION_MAX_SEC = 8 * 60 * 60; // 8 hours

/** The cookie name for embed sessions — FROZEN per D6. */
export const EMBED_COOKIE_NAME = "aiq_embed_sess";

export interface MintEmbedSessionInput {
  userId: string;
  tenantId: string;
  /** JWT exp (unix seconds) — embed session lifetime is min(exp-now, 8h). */
  jwtExp: number;
  ip: string;
  ua: string;
}

export interface MintEmbedSessionResult {
  /** The session token to be set as the aiq_embed_sess cookie value. */
  token: string;
  /** Cookie Max-Age in seconds. */
  maxAge: number;
}

/**
 * Creates an embed candidate session.
 *
 * Returns the raw session token. The caller (route handler) must set the
 * aiq_embed_sess cookie with SameSite=None; Secure; HttpOnly; Path=/.
 */
export async function mintEmbedSession(
  input: MintEmbedSessionInput,
): Promise<MintEmbedSessionResult> {
  const now = Math.floor(Date.now() / 1000);
  const jwtRemaining = Math.max(0, input.jwtExp - now);
  // Cap at 8h (D6) and at JWT exp so embed session never outlives the JWT credential.
  const maxAge = Math.min(jwtRemaining, EMBED_SESSION_MAX_SEC);

  // Create the session via the standard sessions API. This writes to Redis
  // (aiq:sess:<sha256(token)>) and Postgres (sessions table).
  const sessionOut = await sessions.create({
    userId: input.userId,
    tenantId: input.tenantId,
    role: "candidate",
    totpVerified: true,  // embed JWT is the auth factor; no TOTP required
    ip: input.ip,
    ua: input.ua,
  });

  // Mark the session as 'embed' in Postgres for audit/structural guard purposes.
  // The column was added by migration 0071 with DEFAULT 'standard'; this UPDATE
  // sets it to 'embed' so admin queries and structural guards can distinguish.
  await withTenant(input.tenantId, async (client: PoolClient) => {
    await client.query(
      `UPDATE sessions SET session_type = 'embed' WHERE id = $1`,
      [sessionOut.id],
    );
  });

  return {
    token: sessionOut.token,
    maxAge,
  };
}
