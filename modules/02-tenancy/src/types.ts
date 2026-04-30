export type TenantStatus = "active" | "suspended" | "archived";

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
  updated_at: Date;
}
