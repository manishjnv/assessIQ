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
  // Analytics exports (G3.C — admin bulk download is an auditable action)
  'attempt.exported',
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
