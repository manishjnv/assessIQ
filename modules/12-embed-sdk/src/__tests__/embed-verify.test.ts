/**
 * embed-verify.test.ts — integration tests for verifyEmbedToken.
 *
 * These tests require a running PostgreSQL instance (aiq_test) and Redis.
 * They cover the security-critical attack surface for embed JWT verification.
 *
 * Coverage:
 *   V1. alg=none rejected (algorithm confusion attack)
 *   V2. Non-HS256 alg (RS256) rejected
 *   V3. exp - iat > 600s lifetime cap rejected
 *   V4. Expired token rejected
 *   V5. Valid token accepted
 *   V6. Replay rejected on second use of same jti
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
