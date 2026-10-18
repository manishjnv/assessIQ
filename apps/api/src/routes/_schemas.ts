// AssessIQ — apps/api/src/routes/_schemas.ts
//
// RW-36(b): every Zod request schema used by the route files, in one place so
// each can be unit-tested without booting the route's service dependencies and
// documented against docs/03-api-contract.md. Behaviour notes live next to each schema.

import { z, requiredString, queryFlag } from './_validate.js';

// ---- admin-super shared ------------------------------------------
// RW-36(b): body shared by POST/DELETE /tenants/:tenantId/entitlements.
const scopeField = (name: string) =>
  z
    .string({
      required_error: `${name} must be a non-empty string`,
      invalid_type_error: `${name} must be a non-empty string`,
    })
    .max(200, `${name} must be 200 characters or fewer`)
    .refine((s) => s.trim().length > 0, `${name} must be a non-empty string`);
export const entitlementScopeBody = z.object({
  scopeType: scopeField('scopeType'),
  scopeId: scopeField('scopeId'),
});

// ---- admin-super billing -----------------------------------------
// RW-36(b): PATCH plan body. Domain validation (tier set, credit range) stays in updateTenantPlan.
export const updatePlanBody = z.object({
  tier: z.string({ invalid_type_error: 'tier must be a string' }).max(32, 'tier must be 32 characters or fewer').optional(),
  includedCredits: z
    .number({ invalid_type_error: 'includedCredits must be a number or null' })
    .nullable()
    .optional(),
  // PT-4: contract override of AI answers included; null clears it.
  aiAnswersIncludedOverride: z
    .number({ invalid_type_error: 'aiAnswersIncludedOverride must be a number or null' })
    .int('aiAnswersIncludedOverride must be a whole number')
    .min(0, 'aiAnswersIncludedOverride must be 0 or more')
    .max(1_000_000, 'aiAnswersIncludedOverride must be 1000000 or less')
    .nullable()
    .optional(),
});

// ---- admin-super domains -----------------------------------------
// RW-36(b) request schemas.
const NAME_MSG = 'name is required and must be a non-empty string';
export const createDomainBody = z.object({
  name: z
    .string({ required_error: NAME_MSG, invalid_type_error: NAME_MSG })
    .max(200, 'name must be 200 characters or fewer')
    .refine((s) => s.trim().length > 0, NAME_MSG),
  // Non-string description is ignored (unchanged behaviour); service bounds it.
  description: z.unknown().optional(),
});
export const setDomainStatusBody = z.object({
  status: z.enum(['active', 'archived'], {
    errorMap: () => ({ message: 'status must be "active" or "archived"' }),
  }),
});

// ---- admin-super tenants -----------------------------------------
// RW-36(b) request schemas.
export const setAiModeBody = z.object({
  mode: z.custom<'omnibus' | 'sharded' | null>(
    (v) => v === null || v === 'omnibus' || v === 'sharded',
    { message: 'mode must be "omnibus", "sharded", or null' },
  ),
});
export const setAiGradingScopeBody = z.object({ scope: z.enum(['written', 'none']) });
export const renameTenantBody = z.object({
  name: requiredString('name is required', {
    code: 'MISSING_NAME',
    max: 200,
    maxMsg: 'name must not exceed 200 characters',
    maxCode: 'NAME_TOO_LONG',
  }),
});
export const createCompanyBody = z.object({
  name: requiredString('name is required', {
    code: 'MISSING_NAME',
    max: 200,
    maxMsg: 'name must not exceed 200 characters',
    maxCode: 'NAME_TOO_LONG',
  }),
  slug: z
    .string({ required_error: 'slug is required and must be lowercase alphanumeric with hyphens' })
    .max(63, 'slug must be 63 characters or fewer')
    .refine((s) => /^[a-z0-9-]+$/.test(s.trim()), {
      message: 'slug is required and must be lowercase alphanumeric with hyphens',
      params: { code: 'INVALID_SLUG' },
    }),
  adminEmail: z
    .string({ required_error: 'adminEmail is required', invalid_type_error: 'adminEmail is required' })
    .max(254, 'adminEmail must be 254 characters or fewer')
    .refine((s) => s.includes('@'), { message: 'adminEmail is required', params: { code: 'MISSING_ADMIN_EMAIL' } }),
  // domain / adminName: non-string values are ignored (unchanged); createTenant bounds domain.
  domain: z.unknown().optional(),
  adminName: z.unknown().optional(),
});
export const listTenantsQuery = z.object({ include_archived: queryFlag }).passthrough();

// ---- admin-super users -------------------------------------------
// RW-36(b) request schemas.
export const listTenantUsersQuery = z
  .object({ include_disabled: queryFlag, include_deleted: queryFlag })
  .passthrough();
// PATCH /users/:userId. Email format + normalisation stays in the handler (INVALID_EMAIL).
export const editUserBody = z.object({
  name: requiredString('Name must not be empty.', {
    code: 'MISSING_NAME',
    max: 200,
    maxMsg: 'Name must not exceed 200 characters.',
    maxCode: 'NAME_TOO_LONG',
  }).optional(),
  role: z.literal('admin', { errorMap: () => ({ message: "Role must be 'admin'." }) }).optional(),
  email: z
    .string({ invalid_type_error: 'Invalid email address.' })
    .max(254, 'Invalid email address.')
    .optional(),
  confirmEmailIdentityChange: z.boolean().optional(),
  reason: z.unknown().optional(),
});

// ---- tenant settings ---------------------------------------------
// RW-36(b) request schemas. Value rules (name normalisation, retention range 1-3650)
// stay in the 02-tenancy service; these guarantee shape, type and size.
export const renameOwnTenantBody = z.object({
  name: z
    .string({ required_error: 'name is required', invalid_type_error: 'name is required' })
    .refine((s) => s.length <= 500, {
      message: 'name must be between 2 and 120 characters',
      params: { code: 'INVALID_NAME_LENGTH' },
    }),
});
export const resultReleaseModeBody = z.object({
  mode: z.enum(['manual', 'auto'], { errorMap: () => ({ message: "mode must be 'manual' or 'auto'" }) }),
});
export const resultFeedbackLevelBody = z.object({
  level: z.enum(['none', 'right_wrong', 'with_expected_answer', 'with_ai_justification'], {
    errorMap: () => ({ message: 'level must be none, right_wrong, with_expected_answer or with_ai_justification' }),
  }),
});
export const certificateShowDistinctionBody = z.object({
  enabled: z.boolean({
    required_error: 'enabled is required',
    invalid_type_error: 'enabled must be true or false',
  }),
});
export const retentionDaysBody = z.object({
  retention_days: z.number({
    required_error: 'retention_days is required',
    invalid_type_error: 'retention_days is required',
  }),
});
export const runNowQuery = z
  .object({ dryRun: z.string().max(10).optional(), maxPerTenant: z.string().max(10).optional() })
  .passthrough();
export const erasedCandidatesQuery = z
  .object({
    since: z.string().max(64).optional(),
    adminId: z.string().max(64).optional(),
    limit: z.string().max(10).optional(),
  })
  .passthrough();
// ---- admin users -------------------------------------------------
// RW-36(b) request schemas. Field-level domain checks (email format, role/status
// rules, CSV content) stay in the service layer with their existing codes.
export const listUsersQuery = z
  .object({
    page: z.string().max(10).optional(),
    pageSize: z.string().max(10).optional(),
    role: z.string().max(32).optional(),
    status: z.string().max(32).optional(),
    search: z.string().max(200).optional(),
    includeDeleted: z.string().max(10).optional(),
  })
  .passthrough();
// details.code per field via USER_BODY_CODES (pass as parseBody opts); name length uses its own code.
export const USER_BODY_CODES = { email: 'INVALID_EMAIL', role: 'INVALID_ROLE', status: 'INVALID_STATUS' };
const userNameField = z
  .string()
  .refine((s) => s.length <= 200, { message: 'Name must not exceed 200 characters.', params: { code: 'NAME_TOO_LONG' } });
const roleField = z.enum(['admin', 'candidate'], { errorMap: () => ({ message: "Role must be 'admin' or 'candidate'." }) });
export const createUserBody = z.object({
  email: z.string({ invalid_type_error: 'Invalid email address.' }).max(254, 'Invalid email address.'),
  name: userNameField,
  role: roleField,
  metadata: z.record(z.unknown()).optional(),
});
export const updateUserBody = z.object({
  name: userNameField.optional(),
  role: roleField.optional(),
  status: z
    .enum(['active', 'disabled', 'pending'], { errorMap: () => ({ message: "Status must be 'active', 'disabled' or 'pending'." }) })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});
// csv: INVALID_PARAM keeps the pre-existing message/code the UI and tests expect.
export const importUsersBody = z.object({
  csv: z.string({ invalid_type_error: 'csv must be a string', required_error: 'csv must be a string' }),
  assessment_id: z
    .string({ invalid_type_error: 'assessment_id must be a string' })
    .min(1, 'assessment_id must be a string')
    .max(64, 'assessment_id must be 64 characters or fewer')
    .optional(),
});

// ---- admin worker ------------------------------------------------
// RW-36(b): BullMQ job ids are opaque strings (not UUIDs).
export const jobIdParams = z.object({ id: z.string().min(1, 'id is required').max(200, 'id must be 200 characters or fewer') });

// ---- auth candidate ----------------------------------------------
// RW-36(b): public anti-enumeration endpoints. A body that fails the schema gets the
// same neutral response as an empty value (204 / 200 ok:false) - never a 400.
export const requestLinkBody = z.object({ email: z.string().max(254), tenant_slug: z.string().max(63) }).passthrough();
export const verifyLinkBody = z.object({ token: z.string().max(512) }).passthrough();

// ---- auth google -------------------------------------------------
// RW-36(b) request schemas. select -> 400 MISSING_USER_ID (existing); the two
// email-OTP endpoints are anti-enumeration and keep their neutral 200 responses.
export const selectIdentityBody = z.object({
  userId: z
    .string({ required_error: 'userId required', invalid_type_error: 'userId required' })
    .min(1, 'userId required')
    .max(64, 'userId required'),
});
export const emailRequestBody = z.object({ email: z.string().max(254) }).passthrough();
export const emailVerifyBody = z.object({ email: z.string().max(254), code: z.string().max(32) }).passthrough();

// ---- auth embed --------------------------------------------------
// RW-36(b): dev-only minter body (route is only registered when ENABLE_EMBED_TEST_MINTER=1).
export const sdkMintBody = z.object({
  assessmentId: z
    .string({ required_error: 'assessmentId required', invalid_type_error: 'assessmentId required' })
    .min(1, 'assessmentId required')
    .max(64, 'assessmentId must be 64 characters or fewer'),
});

