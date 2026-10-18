/**
 * Service layer for module 05-assessment-lifecycle.
 *
 * IMPORTANT — RLS-only scoping (same rule as 04-question-bank):
 * All queries run through a PoolClient that has already received
 * `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant', $tenantId, true)`
 * from withTenant(). Row-Level Security enforces tenant isolation at the Postgres layer.
 * Do NOT add redundant tenant_id WHERE filters in this file — that would mask RLS bugs.
 *
 * Transaction semantics:
 * withTenant wraps its callback in BEGIN / COMMIT so every multi-step operation
 * (publishAssessment, inviteUsers) that runs inside a single withTenant call is
 * automatically a single database transaction.
 *
 * Pool-size pre-flight (publishAssessment):
 * Counts active questions for (pack_id, level_id) directly via a client.query
 * inside the same withTenant scope (RLS still applies). The question-bank
 * repository's listQuestionRows helper applies a per-page cap so we cannot use
 * it for a raw count without extra gymnastics; a direct COUNT query is cheaper
 * and more explicit. Flagged below — a `countActiveQuestionsForLevel` helper
 * should be added to 04's repository in a follow-up.
 *
 * Token security:
 * Invitation tokens are 32-byte CSPRNG values encoded as base64url. Only the
 * sha256 hash is persisted; the plaintext is placed in the invitation link
 * (email body only) and never logged or stored.
 *
 */

export { resolveBlueprintNodes } from "./service/blueprint.js";
export { listAssessments, getInvitationCounts, getAssessment, getAssessmentDetail, createAssessment, assertIntegritySettings, assertSectionsSettings, createAssessmentFromSet, importLicensedSet, resyncLicensedSet, updateAssessmentIntegrity, updateAssessmentGrading, updateAssessment, type InvitationCounts } from "./service/assessments.js";
export { createMockFromBlueprint, type CreateMockInput } from "./service/mock.js";
export { publishAssessment, closeAssessment, cancelAssessment, deleteAssessment, clearEmptyDrafts, reopenAssessment } from "./service/lifecycle.js";
export { type ResolvedInvitation, resolveInvitationToken, markInvitationViewedByToken } from "./service/invitation-token.js";
export { resendInvitation, resendInvitations, inviteUsers, listInvitations, revokeInvitation, grantExtraAttempt, reopenInvitationForRetake } from "./service/invitations.js";
export { previewAssessment } from "./service/preview.js";
// NOTE: @assessiq/question-bank exposes only its service surface from its
// package barrel. The repository functions (findPackById, findLevelById) are
// internal. We reach them via a relative workspace path. This is intentional
// and documented — a future clean-up could add a `/repository` export entry
// in 04's package.json `exports` map gated to internal workspace consumers.
// Step 2 — clone-on-use: materialise a licensed platform set into this tenant.
// Relative import mirrors the qbRepo / findOrCreatePackForDomain pattern above.

