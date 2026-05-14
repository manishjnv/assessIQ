// AssessIQ — modules/18-certification/src/index.ts
//
// Phase 5 Session 2 — public barrel for @assessiq/certification.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

// ---------------------------------------------------------------------------
// Service (public operations)
// ---------------------------------------------------------------------------
export {
  issueCertificate,
  issueCertificateOnRelease,
  getByCredentialId,
  listForUser,
  adminListCertificates,
  revoke,
  reissue,
  incrementShareCount,
  MAX_CREDENTIAL_ID_RETRIES,
  MAX_TIER_UPGRADE_RETRIES,
  TierUpgradeConflictError,
  type IssueCertificateOptions,
} from './service.js';

// ---------------------------------------------------------------------------
// Cryptography (HMAC signing helpers)
// ---------------------------------------------------------------------------
export {
  CERT_SIGNING_SECRET_ENV,
  getCertSigningSecret,
  signCertificate,
  verifyCertificateSignature,
  type CertificateSignaturePayload,
} from './crypto.js';

// ---------------------------------------------------------------------------
// Credential ID generator
// ---------------------------------------------------------------------------
export {
  DEFAULT_CREDENTIAL_PREFIX,
  generateCredentialId,
  isValidCredentialId,
} from './credential-id.js';

// ---------------------------------------------------------------------------
// Crypto extras
// ---------------------------------------------------------------------------
export { CanonicalPayloadError } from './crypto.js';

// ---------------------------------------------------------------------------
// Repository (exposed for advanced callers + the collision error types)
// ---------------------------------------------------------------------------
export {
  CredentialIdCollisionError,
  findByCredentialIdPublic,
  withPublicVerifyContext,
} from './repository.js';

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------
export {
  registerCertificationRoutes,
  type RegisterCertificationRoutesOptions,
} from './routes.js';

// ---------------------------------------------------------------------------
// Public verify routes (Phase 5 Session 3)
// ---------------------------------------------------------------------------
export { registerVerifyRoutes } from './routes-public.js';

// ---------------------------------------------------------------------------
// Types (public surface)
// ---------------------------------------------------------------------------
export type {
  Certificate,
  CredentialId,
  Tier,
  IssueCertificateInput,
  RevokeCertificateInput,
  ListCertificatesQuery,
} from './types.js';

export {
  TIER_ORDER,
  CREDENTIAL_ID_REGEX,
  TierSchema,
  CredentialIdSchema,
  IssueCertificateInputSchema,
  RevokeCertificateInputSchema,
  ListCertificatesQuerySchema,
} from './types.js';
