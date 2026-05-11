/**
 * embed-verify.test.ts — unit tests for verifyEmbedToken pre-DB rejection paths.
 *
 * V1-V4: algorithm, lifetime, expiry rejections (fire before any DB/Redis call).
 * V5-V6: (valid-token accept + replay) — covered by embed-jwt-db.test.ts
 *         which requires testcontainers DB + Redis.
 *
 * T4:    future-dated iat rejected (iat > now + 5s clock-skew tolerance).
 * T5a-d: missing required claim rejected (tenant_id / sub / email / assessment_id).
 * T11:   malformed JWT (un-parseable header) rejected.
 *
 * None of these tests require a running DB or Redis instance. They all trigger
 * AuthnError from the pre-DB claim/header validation block in verifyEmbedToken.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as jose from 'jose';
import { randomUUID } from 'node:crypto';
import { verifyEmbedToken } from '@assessiq/auth';
import { AuthnError } from '@assessiq/core';

// ─── Test tenant + secret setup ──────────────────────────────────────────────
// We use a raw HS256 key directly (bypassing the DB) for V1-V4 which don't need
// a real active secret. For V5-V6 we need a real tenant + embed_secret row.

// Raw 32-byte key (base64url) for the mock sign operations in V1-V4.
const RAW_SECRET_B64U = Buffer.alloc(32, 0xab).toString('base64url');

async function signRaw(
  payload: Record<string, unknown>,
  alg: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: Uint8Array | any,
): Promise<string> {
  return new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg })
    .sign(key);
}

function hs256Key(b64u: string): Uint8Array {
  return Buffer.from(b64u, 'base64url');
}

// ─── Shared minimal payload ───────────────────────────────────────────────────
const TENANT_ID = '01jhz0000000test000000embed01'; // must exist in test DB (or use skip guard)

function basePayload(overrides: Partial<{
  iat: number;
  exp: number;
  alg: string;
  tenant_id: string;
}> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'test-host',
    aud: 'assessiq',
    sub: 'usr_test',
    tenant_id: overrides.tenant_id ?? TENANT_ID,
    email: 'test@embed.local',
    name: 'Test User',
    assessment_id: randomUUID(),
    iat: overrides.iat ?? now,
    exp: overrides.exp ?? now + 300,
    jti: randomUUID(),
    ...overrides,
  };
}

describe('verifyEmbedToken — algorithm rejection (unit-level, no DB)', () => {
  // These tests verify that tampered tokens are rejected BEFORE any DB call.
  // We sign with a raw key that does NOT correspond to any DB row — the DB
  // lookup happens after the alg check, so the AuthnError is thrown early.

  it('V1: rejects alg=none (algorithm confusion)', async () => {
    // jose SignJWT does not allow alg:none, so we hand-craft the segments.
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'attacker',
      aud: 'assessiq',
      sub: 'owned',
      tenant_id: TENANT_ID,
      email: 'pwned@x.com',
      name: 'Attacker',
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    await expect(verifyEmbedToken(noneToken)).rejects.toThrow(AuthnError);
  });

  it('V2: rejects RS256 signed token (alg confusion)', async () => {
    // Generate ephemeral RSA key for this test only.
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const now = Math.floor(Date.now() / 1000);
    const token = await signRaw({
      iss: 'attacker',
      aud: 'assessiq',
      sub: 'owned',
      tenant_id: TENANT_ID,
      email: 'pwned@x.com',
      name: 'Attacker',
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    }, 'RS256', privateKey);

    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });

  it('V3: rejects token with exp - iat > 600s (lifetime cap)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = hs256Key(RAW_SECRET_B64U);
    const token = await new jose.SignJWT({
      iss: 'test',
      aud: 'assessiq',
      sub: 'usr',
      tenant_id: TENANT_ID,
      email: 'test@test.com',
      name: 'Test',
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 601,  // 601s > cap
      jti: randomUUID(),
    } as jose.JWTPayload).setProtectedHeader({ alg: 'HS256' }).sign(key);

    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });

  it('V4: rejects expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = hs256Key(RAW_SECRET_B64U);
    const token = await new jose.SignJWT({
      iss: 'test',
      aud: 'assessiq',
      sub: 'usr',
      tenant_id: TENANT_ID,
      email: 'test@test.com',
      name: 'Test',
      assessment_id: randomUUID(),
      iat: now - 700,
      exp: now - 100,  // expired 100s ago
      jti: randomUUID(),
    } as jose.JWTPayload).setProtectedHeader({ alg: 'HS256' }).sign(key);

    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });
});

// ─── Additional pre-DB unit tests ────────────────────────────────────────────
// These tests fire AuthnError from the pre-DB validation block in
// verifyEmbedToken — BEFORE any call to withTenant/DB/Redis.
// They use RAW_SECRET_B64U (a random key unrelated to any DB row) for signing.
//
// Why this is safe: verifyEmbedToken checks alg, claims, lifetime, and iat
// before it opens a DB connection.  Tokens rejected here never reach the
// signature-verification or replay-cache layers.

describe('verifyEmbedToken — future-dated iat (clock-skew attack, T4)', () => {
  it('T4: rejects token with iat 60s in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = hs256Key(RAW_SECRET_B64U);
    // iat = now + 60: exceeds the 5s clock-skew allowance.
    // exp - iat = 300 ≤ 600: passes lifetime cap so that check is NOT the reason
    // for rejection.  The iat-future-skew check fires exclusively.
    const token = await new jose.SignJWT({
      iss: 'test',
      aud: 'assessiq',
      sub: 'usr',
      tenant_id: TENANT_ID,
      email: 'test@test.com',
      name: 'Test',
      assessment_id: randomUUID(),
      iat: now + 60,   // 60s future — well past the ±5s allowed skew
      exp: now + 360,  // 300s after iat, not expired
      jti: randomUUID(),
    } as jose.JWTPayload).setProtectedHeader({ alg: 'HS256' }).sign(key);

    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });
});

describe('verifyEmbedToken — missing required claims (T5a-T5d)', () => {
  // Each test omits exactly one required claim to isolate the specific rejection.
  // The signing key (RAW_SECRET_B64U) is irrelevant — the error fires at the
  // typeof-check block before any signature verification.

  async function signMissingClaim(omit: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const key = hs256Key(RAW_SECRET_B64U);
    const full: Record<string, unknown> = {
      iss: 'test',
      aud: 'assessiq',
      sub: 'usr',
      tenant_id: TENANT_ID,
      email: 'test@test.com',
      name: 'Test',
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    };
    delete full[omit];
    return new jose.SignJWT(full as jose.JWTPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(key);
  }

  it('T5a: rejects token missing tenant_id claim', async () => {
    const token = await signMissingClaim('tenant_id');
    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });

  it('T5b: rejects token missing sub claim', async () => {
    const token = await signMissingClaim('sub');
    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });

  it('T5c: rejects token missing email claim', async () => {
    const token = await signMissingClaim('email');
    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });

  it('T5d: rejects token missing assessment_id claim', async () => {
    const token = await signMissingClaim('assessment_id');
    await expect(verifyEmbedToken(token)).rejects.toThrow(AuthnError);
  });
});

describe('verifyEmbedToken — malformed JWT structure (T11)', () => {
  it('T11: rejects string that is not a valid JWT (decodeProtectedHeader fails)', async () => {
    // 'not.a.valid.jwt' — the first segment 'not' base64url-decodes to
    // a 2-byte binary value, not a JSON object, so decodeProtectedHeader throws.
    // This confirms the impl fails closed on garbage input.
    await expect(verifyEmbedToken('not.a.valid.jwt')).rejects.toThrow(AuthnError);
  });

  it('T11b: rejects a single-segment string (no dots at all)', async () => {
    await expect(verifyEmbedToken('onlyone')).rejects.toThrow(AuthnError);
  });

  it('T11c: rejects empty string', async () => {
    await expect(verifyEmbedToken('')).rejects.toThrow(AuthnError);
  });
});
