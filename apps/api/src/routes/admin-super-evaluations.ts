// AssessIQ — apps/api/src/routes/admin-super-evaluations.ts
//
// Platform evaluation queue (Phase II, 2026-10-01) — super-admin-only routes.
//
// Owner decision: AI evaluation is run ONLY by the platform super admin (the owner,
// whose Claude subscription runs Claude Code on the VPS). Tenant admins never
// trigger AI; they review the released evaluation, override a score, send it back
// for re-evaluation, and publish. The tenant routes that used to grade answer
// 403 AI_EVALUATION_BY_ASSESSIQ (modules/07-ai-grading routes.ts).
//
// Route prefix: /api/admin/super/evaluations   (cross-tenant — role = 'super_admin')
//   GET  /api/admin/super/evaluations[?tenant_id=]            queue, all tenants, no candidate PII
//   GET  /api/admin/super/evaluations/:attemptId              review payload (blind)
//   POST /api/admin/super/evaluations/:attemptId/grade        THE AI trigger (admin click, sync)
//   POST /api/admin/super/evaluations/:attemptId/accept       commit proposals (does NOT release)
//   POST /api/admin/super/evaluations/:attemptId/rerun
//   POST /api/admin/super/evaluations/:attemptId/questions/:questionId/manual-score   (fresh MFA)
//   POST /api/admin/super/evaluations/:attemptId/gradings/:gradingId/override         (fresh MFA)
//   POST /api/admin/super/evaluations/:attemptId/release-to-tenant
//   POST /api/admin/super/evaluations/release-to-tenant       bulk
//
// This file owns the AUTH CHAINS only (same definitions as admin-super.ts); the route
// bodies live in modules/07-ai-grading routes-super.ts, injected with these chains —
// the same DI shape as registerGradingRoutes. Per request that module resolves the
// attempt's tenant from the DB (system-role read-only lookup + assertTenantActive) and
// runs the existing 07 handlers inside withTenant(<attempt's tenant>), so RLS applies
// and audit rows land in that tenant's log with the super admin as actor. The AI is
// only ever started by handleAdminGrade / handleAdminRerun on a super admin's click —
// nothing in apps/api's worker or cron paths imports @assessiq/ai-grading.

import type { FastifyInstance } from 'fastify';
import { registerSuperEvaluationRoutes } from '@assessiq/ai-grading';
import { authChain } from '../middleware/auth-chain.js';

// Gate: session must exist AND role must be 'super_admin'. requireAuth enforces
// totpVerified=true for super_admin unconditionally (see admin-super.ts).
const superAdminOnly = authChain({ roles: ['super_admin'] });

// Fresh-MFA gate (TOTP within 15 min) for the score-changing actions.
const superAdminFreshMfa = authChain({
  roles: ['super_admin'],
  freshMfaWithinMinutes: 15,
});

export async function registerAdminSuperEvaluationsRoutes(app: FastifyInstance): Promise<void> {
  await registerSuperEvaluationRoutes(app, { superAdminOnly, superAdminFreshMfa });
}
