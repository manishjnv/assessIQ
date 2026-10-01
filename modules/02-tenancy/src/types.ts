export type TenantStatus = "active" | "suspended" | "archived" | "provisioning";

export interface TenantBranding {
  logo_url?: string;
  primary?: string;          // hex like "#5eead4"
  favicon_url?: string;
  product_name_override?: string;
}

export interface GoogleSsoMethod {
  enabled: boolean;
  allowed_domains: string[];
}

export interface MagicLinkMethod {
  enabled: boolean;
  ttl_hours: number;
}

export interface PasswordMethod {
  enabled: boolean;
  min_length: number;
}

export interface SamlMethod {
  enabled: boolean;
  idp_metadata_url: string | null;
}

export interface OidcExtraMethod {
  enabled: boolean;
  config: Record<string, unknown> | null;
}

export interface TenantAuthMethods {
  google_sso?: GoogleSsoMethod;
  totp_required?: boolean;
  magic_link?: MagicLinkMethod;
  password?: PasswordMethod;
  saml?: SamlMethod;
  oidc_extra?: OidcExtraMethod;
}

export interface Tenant {
  id: string;          // UUID
  slug: string;
  name: string;
  domain: string | null;
  branding: TenantBranding;
  status: TenantStatus;
  created_at: Date;
  updated_at: Date;
}

export interface TenantSettings {
  tenant_id: string;
  auth_methods: TenantAuthMethods;
  ai_grading_enabled: boolean;
  ai_model_tier: "basic" | "standard" | "premium";
  features: Record<string, unknown>;
  webhook_secret: string | null;   // encrypted on the wire — do NOT log this field
  data_region: string;
  /**
   * Per-tenant override for AI_GENERATE_MODE.
   * NULL means "use the global AI_GENERATE_MODE env var".
   * Non-NULL values override the env var for this tenant only, effective
   * on the next request with no container restart.
   * See docs/design/2026-05-10-stage-3-promotion-rollout.md §3.
   */
  ai_generate_mode: "omnibus" | "sharded" | null;
  /**
   * DPDP / GDPR per-tenant candidate-data retention window in DAYS.
   * Added by modules/20-data-rights migration 0103 (default 730 = 2 years).
   * The nightly retention cron (apps/api/src/worker.ts dsr-retention-cron)
   * uses this to tombstone PII for candidates past the window. Distinct from
   * audit_retention_years (audit_log forensic-chain). Range 1–3650 enforced
   * by SQL CHECK.
   */
  retention_days: number;
  /**
   * How a finished (complete, final) result reaches the candidate. Added by
   * migration 0114.
   *   manual (default) — hidden until a tenant admin publishes it.
   *   auto             — published as soon as it is complete (worker sweep
   *                      `result.auto_release`).
   * Only changed through updateResultReleaseMode (audited); NOT part of the
   * generic updateTenantSettingsRow patch.
   */
  result_release_mode: "manual" | "auto";
  /**
   * When the tenant switched manual -> auto (NULL while 'manual'). The
   * auto-release sweep only publishes attempts whose evaluation was released at
   * or after this moment, so a switch to 'auto' never releases the results that
   * were already waiting. Set / cleared by updateResultReleaseMode only.
   */
  result_release_auto_since: Date | null;
  updated_at: Date;
}
