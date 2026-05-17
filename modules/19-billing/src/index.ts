// AssessIQ — modules/19-billing/src/index.ts
//
// Public surface of the @assessiq/billing module.
// Consumers import only from this barrel; internal files are not stable API.

export type {
  PlanTier,
  TenantPlanRow,
  UsageStatus,
  BillingUsage,
  // A2 types
  TenantUsageRow,
  TenantBillingDetail,
  BillingEventRow,
  UpdateTenantPlanPatch,
  UpdateTenantPlanResult,
} from './types.js';

export {
  DEFAULT_FREE_CREDITS,
  recordGradedAttempt,
  provisionDefaultPlan,
  computeUsage,
  getUsage,
  // A2 exports
  getAllTenantUsage,
  getTenantBillingDetail,
  getTenantBillingEventsCsv,
  updateTenantPlan,
} from './service.js';

export {
  registerBillingRoutes,
  type BillingRouteDeps,
} from './routes.js';
