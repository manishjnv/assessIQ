// AssessIQ — modules/14-audit-log/src/types.ts
//
// Phase 3 G3.A — shared types for the audit-log module.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
// Audit is deterministic event capture. Rule #1 CLAUDE.md.

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

export type ActorKind = 'user' | 'api_key' | 'system';

// ---------------------------------------------------------------------------
// Action catalog — branded string type ensures callers use only known actions.
// New actions must be added here; the runtime validator enforces the set.
// ---------------------------------------------------------------------------

export const ACTION_CATALOG = [
  // Auth
  'auth.login.totp_success',
  'auth.login.totp_failed',
  'auth.login.locked',
  'auth.totp.enrolled',
  'auth.totp.reset',
  'auth.recovery.used',
  // Tenant
  'tenant.settings.updated',
  'tenant.branding.updated',
  'tenant.suspended',
  // User
  'user.created',
  'user.role.changed',
  'user.disabled',
  'user.deleted',
  // Question bank
  'pack.created',
  'pack.published',
  'pack.archived',
  'question.created',
  'question.updated',
  'question.imported',
  // Assessment lifecycle
  'assessment.created',
  'assessment.updated',
  'assessment.published',
  'assessment.closed',
  'assessment.invite',
  // Attempt
  'attempt.started',
  'attempt.submitted',
  'attempt.released',
  'attempt.deleted',
  // Grading
  'grading.override',
  'grading.retry',
  // G3.D 07-ai-grading sweep (2026-05-13) — admin-mutating handlers in the
  // grading lifecycle. Each emits one audit row inside the same withTenant
  // transaction as its DB mutation (auditInTx).
  // - grading.accepted: admin commits AI proposals to gradings rows (handler:
  //   admin-accept.ts; covers the "accept before commit" D8 invariant).
  // - grading.claimed: admin opens the attempt page, transitioning
  //   attempts.status submitted → pending_admin_grading (handler:
  //   admin-claim-release.ts handleAdminClaimAttempt).
  // - grading.released: admin releases the graded attempt to the candidate,
  //   transitioning attempts.status graded → released (handler:
  //   admin-claim-release.ts handleAdminReleaseAttempt).
  'grading.accepted',
  'grading.claimed',
  'grading.released',
  // G3.D 07-ai-grading sweep — admin question generation via Claude Code CLI.
  // Distinct from question.created (manual admin authoring) so audit queries
  // can separate AI-drafted vs human-authored creation paths. One audit row
  // per generation batch with the inserted question_ids in the after payload.
  'question.ai_generated',
  // API keys + embed
  'api_key.created',
  'api_key.revoked',
  'embed_secret.created',
  'embed_secret.rotated',
  'embed_secret.revoked',
  // Embed origins (Phase 4 12-embed-sdk)
  'embed_origin.added',
  'embed_origin.removed',
  // Webhooks
  'webhook.created',
  'webhook.deleted',
  'webhook.replayed',
  'webhook_secret.rotated',
  // Help system
  'help.content.updated',
  'help.content.imported',
  // Analytics exports (G3.C — admin bulk download is an auditable action)
  'attempt.exported',
  // Dev-only E2E test-minter — off in production per ENABLE_E2E_TEST_MINTER gate.
  // Auditable so dev/staging test runs are traceable in the audit trail.
  'dev.mint_session',
  // Super-admin — per-tenant AI generation mode flip (Stage 3 rollout).
  'tenant_settings.ai_generate_mode.updated',
  // Super-admin — company onboarding (C4 of super-admin-onboarding contract).
  // tenant.created: fired on full success (provisioning→active flip complete).
  // tenant.create_incomplete: fired when provisioning succeeds but a later step
  // (taxonomy seed or admin invite) fails; tenant stays 'provisioning'.
  'tenant.created',
  'tenant.create_incomplete',
  // Phase 5 Credentialize — certificate issuance + tier upgrade.
  // See modules/18-certification/SKILL.md and docs/CERTIFICATION_PLAN_GENERIC.md.
  'certification.cert.issue',
  'certification.cert.upgrade',
  // Phase 5 Session 5 — admin revoke + reissue operations.
  'certificates.revoked',
  'certificates.reissued',
  // G3.D 03-users sweep (2026-05-11) — admin user-management mutations.
  // Generic "something on a user changed" with before/after diff + kind marker.
  'user.updated',
  // Inverse of user.deleted; kept distinct so admin queries on
  // "who restored this account" don't have to filter on a marker field.
  'user.restored',
  // Issued via POST /api/admin/invitations. Distinct from user.created so
  // queries can separate "admin manually provisioned" from "admin invited
  // and the user later accepted via magic link."
  'user.invited',
  // G3.D 09-scoring sweep (2026-05-11) — admin-triggered score recompute.
  // Fired by recomputeOnOverride() when an admin grading override causes a
  // score rollup recompute. before/after capture the score delta for forensics.
  // before is null on first compute (INSERT-only; no prior row to snapshot).
  'attempt_scores.recomputed_by_admin',
  // Candidate passwordless magic-link login (2026-05-13).
  // Distinct from the existing assessment magic-link (user_invitations / /take/<token>).
  // These events track the certificate-view login flow; no PII in payload.
  'auth.candidate.login_link_requested',
  'auth.candidate.login_link_consumed',
  // Phase A2 billing — super-admin plan update (tier / included_credits).
  // Fired inside updateTenantPlan via auditInTx (same tx as the UPDATE).
  'tenant.plan_updated',
] as const;

export type ActionName = (typeof ACTION_CATALOG)[number];

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

/** Input to the audit() helper — passed by the calling module. */
export interface AuditInput {
  tenantId: string;
  actorKind: ActorKind;
  /** UUID of the user, api key, or system identity performing the action. */
  actorUserId?: string;
  action: ActionName;
  entityType: string;
  entityId?: string;
  /** State BEFORE the mutation (will be redacted before writing). */
  before?: Record<string, unknown>;
  /** State AFTER the mutation (will be redacted before writing). */
  after?: Record<string, unknown>;
  /** IPv4/IPv6 address. Auto-filled from RequestContext if omitted. */
  ip?: string;
  /** User-agent string. Auto-filled from RequestContext if omitted. */
  userAgent?: string;
}

/** A row as returned from the database by the service layer. */
export interface AuditRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  actor_kind: ActorKind;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  at: string;
}

// ---------------------------------------------------------------------------
// Query input
// ---------------------------------------------------------------------------

export interface AuditListFilters {
  actorUserId?: string | undefined;
  actorKind?: ActorKind | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: string | undefined; // ISO timestamp
  to?: string | undefined;   // ISO timestamp
}

export interface AuditListInput {
  tenantId: string;
  filters?: AuditListFilters;
  page: number;     // 1-based
  pageSize: number; // max 200
}

export interface AuditExportInput {
  tenantId: string;
  filters?: AuditListFilters;
}
