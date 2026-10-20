// AssessIQ — modules/19-billing/src/index.ts
//
// Public surface of the @assessiq/billing module.
// Consumers import only from this barrel; internal files are not stable API.

export type {
  PlanTier,
  TenantPlanRow,
  UsageStatus,
  BillingUsage,
  TierLimitsView,
  // A2 types
  TenantUsageRow,
  TenantBillingDetail,
  BillingEventRow,
  UpdateTenantPlanPatch,
  UpdateTenantPlanResult,
  // B1 types
  EntitlementScopeType,
  TenantEntitlement,
  GrantEntitlementInput,
  CreditBalance,
  CreditGrantView,
} from './types.js';

export {
  DEFAULT_FREE_CREDITS,
  recordGradedAttempt,
  // FU-A2 / FU-A4 / FU-A9 exports
  recordAiAnswerEvaluated,
  cycleWindowStart,
  TIER_AI_ANSWERS_INCLUDED,
  provisionDefaultPlan,
  provisionDefaultPlanInTx,
  computeUsage,
  getUsage,
  // A2 exports
  getAllTenantUsage,
  getTenantBillingDetail,
  getTenantBillingEventsCsv,
  updateTenantPlan,
  // B1 exports
  grantEntitlement,
  revokeEntitlement,
  listTenantEntitlements,
  getCompanyEntitlements,
  // D1 exports
  listTenantContentScopes,
  // B2 exports
  assertPublishEntitled,
  // Step 2 — clone-on-use exports
  assertLicensedForSourcePack,
  listAvailableSetsForTenant,
  // FU-A3 exports
  tierAllows,
  TIER_DISPLAY_NAMES,
  // PT1 / PT-4 exports
  TIER_LIMITS,
  tierDenial,
  assertTierAllows,
  assertTierLimit,
  assertCreditsUnderHardCap,
  assertCandidateTotalCap,
  countCandidateOrRefuse,
  assertCandidateRoleChange,
  assertAiAttemptAllowed,
  getTierLimits,
  // Z-93 credit ledger
  getCreditBalance,
  grantCredits,
  listTenantCredits,
  refillFreeMonthlyCredits,
  expireCredits,
  sendCreditLowBalanceNotices,
} from './service.js';

export type { GrantCreditsInput } from './service.js';
export { BURN, FREE_MONTHLY_CREDITS, GRANT_VALIDITY_MONTHS, LOW_BALANCE_THRESHOLD_RATIO, LOW_BALANCE_LEVELS } from './burn-rates.js';

export type { TierFeature } from './service.js';

export type { AvailableSet } from './types.js';

// Z-71 self-serve sign-up: Free plan + monthly grant + sample-set entitlements in the caller's tx.
export { provisionSelfServePlan, FREE_SAMPLE_PACK_SLUGS } from './self-serve-plan.js';

export {
  registerBillingRoutes,
  type BillingRouteDeps,
} from './routes.js';
