export { getPool, closePool, setPoolForTesting } from "./pool.js";
export { assertTenantActive } from "./lifecycle.js";
export { withTenant, withSystemRole, onCommit } from "./with-tenant.js";
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
  updateAiGradingScope,
  getAiGradingScope,
  updateRetentionDays,
  updateResultReleaseMode,
  updateResultFeedbackLevel,
  getResultFeedbackLevel,
  updateCertificateShowDistinction,
  getCertificateShowDistinction,
  renameTenant,
  normalizeTenantName,
  createTenant,
  activateTenant,
  renameTenantAsSuperAdmin,
  listTenantsForSuperAdmin,
  isPrivacyDisclosed,
  setTenantLogo,
  removeTenantLogo,
  getTenantLogoMeta,
  getTenantLogoBytes,
  tenantLogoUrl,
} from "./service.js";
export type {
  UpdateAiGenerateModeResult,
  UpdateAiGradingScopeResult,
  AiGradingScope,
  UpdateRetentionDaysResult,
  UpdateResultReleaseModeResult,
  ResultReleaseMode,
  UpdateResultFeedbackLevelResult,
  UpdateCertificateShowDistinctionResult,
  RenameTenantResult,
  CreateTenantInput,
  CreateTenantResult,
  TenantLifecycleResult,
  TenantLogoMeta,
} from "./service.js";
export { sniffImage, validateLogo, LOGO_MAX_BYTES, LOGO_MIN_PX, LOGO_MAX_PX } from "./logo.js";
export { purgeArchivedTenants, MIN_PURGE_DAYS } from "./purge.js";
export type { PurgeOptions, PurgeReport, TenantPurgeReport } from "./purge.js";
export { findTenantSettings } from "./repository.js";
export type {
  Tenant,
  TenantSettings,
  TenantBranding,
  TenantAuthMethods,
  TenantStatus,
  ResultFeedbackLevel,
} from "./types.js";
export { RESULT_FEEDBACK_LEVELS } from "./types.js";
