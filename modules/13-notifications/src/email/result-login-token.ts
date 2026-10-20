/**
 * modules/13-notifications/src/email/result-login-token.ts
 *
 * Z-15 (a): mint a one-time sign-in token for the "View your result" button of
 * the result email. Same table and hash as the normal candidate login link
 * (candidate_login_tokens, sha256 hex, verified by verifyCandidateLoginTokenSystem
 * in @assessiq/auth), only the lifetime differs: 7 days instead of 15 minutes.
 * The normal login-link TTL in @assessiq/auth is NOT touched.
 *
 * Lives here (not in @assessiq/auth) because @assessiq/auth already depends on
 * this package; the reverse import would be a cycle.
 */

import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sha256Hex } from '@assessiq/core';

export const RESULT_LOGIN_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** Insert a hashed 7-day token for the user; returns the plaintext (emailed once, never logged). */
export async function mintResultLoginToken(
  client: PoolClient,
  input: { tenantId: string; userId: string },
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  // Gate finding (2026-10-20): a re-release or retry must not leave older 7-day links alive.
  // Only long-lived tokens are retired; a 15-minute login link the student just asked for stays valid.
  await client.query(
    `UPDATE candidate_login_tokens SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now() + interval '1 hour'`,
    [input.userId],
  );
  await client.query(
    `INSERT INTO candidate_login_tokens (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [input.tenantId, input.userId, sha256Hex(token), RESULT_LOGIN_TOKEN_TTL_SEC],
  );
  return token;
}
