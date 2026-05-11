// AssessIQ — modules/18-certification/src/__tests__/crypto.test.ts
//
// Phase 5 Session 2 — unit tests for the HMAC signing helpers.
//
// Coverage:
//   - HMAC determinism across invocations (3x same → identical bytes)
//   - HMAC drift snapshot — the canonical-serialization order must not
//     change without an intentional re-baseline of every existing cert row.
//   - Field sensitivity — flipping any one field changes the digest.
//   - Verify success / tampered / wrong-secret / length-mismatch.
//   - getCertSigningSecret env-var safety (no default, no fallback).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CERT_SIGNING_SECRET_ENV,
  CanonicalPayloadError,
  getCertSigningSecret,
  signCertificate,
  verifyCertificateSignature,
  type CertificateSignaturePayload,
} from '../crypto.js';

const FIXED_PAYLOAD: CertificateSignaturePayload = {
  id: '11111111-1111-1111-1111-111111111111',
  tenant_id: '22222222-2222-2222-2222-222222222222',
  candidate_id: '33333333-3333-3333-3333-333333333333',
  attempt_id: '44444444-4444-4444-4444-444444444444',
  template_key: 'soc-l1-completion',
  credential_id: 'AIQ-2026-05-A7F3K9',
  tier: 'completion',
  display_name: 'Jane Doe',
  course_title: 'SOC Analyst L1',
  level: 'L1',
  issued_at: '2026-05-11T15:00:00.000Z',
};

const FIXED_SECRET = 'unit-test-secret';

// Precomputed digest of FIXED_PAYLOAD + FIXED_SECRET. If this fails after a
// legitimate algorithm change (e.g. you change the canonical-serialization
// order), update this value AND publish a re-sign migration for every row.
const FIXED_EXPECTED_HEX =
  '9db418301f0ae0a8c9b8b8f7e813d2bb466b530c21ca71ac1610b3f51459a983';

describe('signCertificate — determinism', () => {
  it('produces identical hex across 3 successive invocations', () => {
    const s1 = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    const s2 = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    const s3 = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the pinned hex digest for the fixed payload', () => {
    expect(signCertificate(FIXED_PAYLOAD, FIXED_SECRET)).toBe(FIXED_EXPECTED_HEX);
  });

  it('is independent of the order of keys in the input object', () => {
    // Build a payload with deliberately shuffled key insertion order.
    const shuffled: CertificateSignaturePayload = {
      tier: FIXED_PAYLOAD.tier,
      issued_at: FIXED_PAYLOAD.issued_at,
      level: FIXED_PAYLOAD.level,
      attempt_id: FIXED_PAYLOAD.attempt_id,
      display_name: FIXED_PAYLOAD.display_name,
      course_title: FIXED_PAYLOAD.course_title,
      candidate_id: FIXED_PAYLOAD.candidate_id,
      credential_id: FIXED_PAYLOAD.credential_id,
      template_key: FIXED_PAYLOAD.template_key,
      tenant_id: FIXED_PAYLOAD.tenant_id,
      id: FIXED_PAYLOAD.id,
    };
    expect(signCertificate(shuffled, FIXED_SECRET)).toBe(FIXED_EXPECTED_HEX);
  });
});

describe('signCertificate — field sensitivity', () => {
  it('flipping any single field changes the digest', () => {
    const base = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    for (const key of Object.keys(FIXED_PAYLOAD) as Array<keyof CertificateSignaturePayload>) {
      // For each field, swap to a value of the correct type so the typed
      // payload still type-checks. tier needs a different enum member.
      const tampered: CertificateSignaturePayload =
        key === 'tier'
          ? { ...FIXED_PAYLOAD, tier: 'honors' }
          : { ...FIXED_PAYLOAD, [key]: `${FIXED_PAYLOAD[key]}-tampered` };
      const sig = signCertificate(tampered, FIXED_SECRET);
      expect(sig, `field ${String(key)} must affect the digest`).not.toBe(base);
    }
  });

  it('throws when secret is empty', () => {
    expect(() => signCertificate(FIXED_PAYLOAD, '')).toThrow(/non-empty/);
  });
});

describe('verifyCertificateSignature', () => {
  it('accepts a freshly signed payload', () => {
    const sig = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    expect(verifyCertificateSignature(FIXED_PAYLOAD, sig, FIXED_SECRET)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    const tampered: CertificateSignaturePayload = { ...FIXED_PAYLOAD, tier: 'honors' };
    expect(verifyCertificateSignature(tampered, sig, FIXED_SECRET)).toBe(false);
  });

  it('rejects when the secret differs', () => {
    const sig = signCertificate(FIXED_PAYLOAD, FIXED_SECRET);
    expect(verifyCertificateSignature(FIXED_PAYLOAD, sig, 'wrong-secret')).toBe(false);
  });

  it('returns false (does not throw) on length mismatch', () => {
    expect(verifyCertificateSignature(FIXED_PAYLOAD, 'short', FIXED_SECRET)).toBe(false);
    expect(verifyCertificateSignature(FIXED_PAYLOAD, '', FIXED_SECRET)).toBe(false);
    expect(
      verifyCertificateSignature(FIXED_PAYLOAD, FIXED_EXPECTED_HEX + '00', FIXED_SECRET),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R6 — canonicalize closed-field-set: extra fields ignored, missing fields throw
// ---------------------------------------------------------------------------

describe('signCertificate — R6: closed canonical field set', () => {
  it('extra fields on the object do NOT change the digest', () => {
    // Cast is needed to sneak in extra_field at the call site.
    const withExtra = { ...FIXED_PAYLOAD, extra_field: 'should-be-ignored' } as CertificateSignaturePayload;
    expect(signCertificate(withExtra, FIXED_SECRET)).toBe(signCertificate(FIXED_PAYLOAD, FIXED_SECRET));
  });

  it('throws CanonicalPayloadError when a required field is undefined', () => {
    // Omit 'tier' by casting through unknown.
    const missingTier = { ...FIXED_PAYLOAD, tier: undefined } as unknown as CertificateSignaturePayload;
    expect(() => signCertificate(missingTier, FIXED_SECRET)).toThrow(CanonicalPayloadError);
    expect(() => signCertificate(missingTier, FIXED_SECRET)).toThrow(/tier/);
  });
});

describe('getCertSigningSecret', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[CERT_SIGNING_SECRET_ENV];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[CERT_SIGNING_SECRET_ENV];
    } else {
      process.env[CERT_SIGNING_SECRET_ENV] = saved;
    }
  });

  it('returns the env value when set', () => {
    process.env[CERT_SIGNING_SECRET_ENV] = 'live-secret-value';
    expect(getCertSigningSecret()).toBe('live-secret-value');
  });

  it('throws when env var is unset', () => {
    delete process.env[CERT_SIGNING_SECRET_ENV];
    expect(() => getCertSigningSecret()).toThrow(
      new RegExp(CERT_SIGNING_SECRET_ENV),
    );
  });

  it('throws when env var is empty string', () => {
    process.env[CERT_SIGNING_SECRET_ENV] = '';
    expect(() => getCertSigningSecret()).toThrow(
      new RegExp(CERT_SIGNING_SECRET_ENV),
    );
  });
});
