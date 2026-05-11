// AssessIQ — modules/18-certification/src/index.ts
//
// Phase 5 Session 1 — public barrel for @assessiq/certification.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

// ---------------------------------------------------------------------------
// Service (public operations)
// ---------------------------------------------------------------------------
export {
  issueCertificate,
  getByCredentialId,
  listForUser,
  adminListCertificates,
  revoke,
  reissue,
} from './service.js';

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------
export {
  registerCertificationRoutes,
  type RegisterCertificationRoutesOptions,
} from './routes.js';

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
