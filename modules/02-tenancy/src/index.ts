export { getPool, closePool, setPoolForTesting } from "./pool.js";
export { assertTenantActive } from "./lifecycle.js";
export { withTenant, onCommit } from "./with-tenant.js";
export { tenantContextMiddleware } from "./middleware.js";
export {
  getTenantById,
  getTenantBySlug,
  listActiveTenantIds,
  updateTenantSettings,
  suspendTenant,
  resumeTenant,
  archiveTenant,
  unarchiveTenant,
  updateAiGenerateMode,
  updateRetentionDays,
  updateResultReleaseMode,
  renameTenant,
  normalizeTenantName,
  createTenant,
  activateTenant,
} from "./service.js";
export type {
  UpdateAiGenerateModeResult,
  UpdateRetentionDaysResult,
  UpdateResultReleaseModeResult,
  ResultReleaseMode,
  RenameTenantResult,
  CreateTenantInput,
  CreateTenantResult,
  TenantLifecycleResult,
} from "./service.js";
export { findTenantSettings } from "./repository.js";
export type {
  Tenant,
  TenantSettings,
  TenantBranding,
  TenantAuthMethods,
  TenantStatus,
} from "./types.js";
