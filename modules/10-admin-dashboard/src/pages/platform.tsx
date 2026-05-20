// AssessIQ — Super-admin Platform page.
//
// Provision new company tenants and list all provisioned tenants.
// Gate: super_admin role + fresh TOTP (enforced by backend — 401 AUTHN_FAILED
// with "fresh totp" triggers in-form MFA step-up, preserving all entered values).
//
// Pattern mirrors users.tsx exactly:
//   - AdminShell wrapper
//   - Serif h1 + count Chip + lede + primary CTA
//   - Fixed-position centred Card modal with backdrop + stopPropagation
//   - Field / Button / Chip / Spinner from @assessiq/ui-system
//   - META_LABEL / ROW_GRID / zebra rows
//   - data-help-id on form controls

import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Button, Card, Chip, Field, Spinner } from "@assessiq/ui-system";
import type { ChipVariant } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import {
  AdminApiError,
  createCompanyApi,
  resendInvitationApi,
  listTenantsApi,
  verifyTotpApi,
  getTenantBillingDetail,
  updateTenantPlan,
  tenantBillingCsvUrl,
  getTenantEntitlements,
  getTenantContentScopes,
  grantTenantEntitlement,
  revokeTenantEntitlement,
  suspendTenantApi,
  resumeTenantApi,
  archiveTenantApi,
  unarchiveTenantApi,
  type CreateCompanyRequest,
  type TenantListItem,
  type TenantBillingDetail,
  type TenantEntitlement,
  type TenantContentScopes,
  type LifecycleResponse,
} from "../api.js";
import { HelpTip } from "@assessiq/help-system/components";
import { fetchAdminWhoami } from "../session.js";

// ── Types ────────────────────────────────────────────────────────────────────

type TenantStatus = "active" | "provisioning" | "suspended" | "archived" | string;

type LifecycleAction = "suspend" | "resume" | "archive" | "unarchive";

interface LifecycleModalState {
  action: LifecycleAction;
  tenant: TenantListItem;
}

const STATUS_VARIANT: Record<string, ChipVariant> = {
  active: "success",
  provisioning: "accent",
  suspended: "default",
  archived: "default",
};

function statusVariant(status: TenantStatus): ChipVariant {
  return (STATUS_VARIANT[status] as ChipVariant | undefined) ?? "default";
}

// ── Styles (mirrors users.tsx) ────────────────────────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--aiq-color-fg-muted)",
};

const ROW_GRID = "1fr 1.2fr 2.1fr 150px 110px 110px";
const ROW_GRID_GAP = 12;
const ROW_PADDING = "16px 20px";

// ── Slug utils ────────────────────────────────────────────────────────────────

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const SLUG_RE = /^[a-z0-9-]+$/;

// ── Date formatter ────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── MFA step-up sub-form ──────────────────────────────────────────────────────

type MfaState =
  | { status: "idle" }
  | { status: "locked" }
  | { status: "expired" }
  | { status: "error"; message: string };

function MfaStepUp({
  onVerified,
  onCancel,
}: {
  onVerified: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<MfaState>({ status: "idle" });

  const handleInput = (raw: string): void => {
    // Strip non-digits, clamp to 6 chars
    setCode(raw.replace(/\D/g, "").slice(0, 6));
    setState({ status: "idle" });
  };

  const verify = async (): Promise<void> => {
    if (code.length !== 6) return;
    setLoading(true);
    setState({ status: "idle" });
    try {
      await verifyTotpApi(code);
      // Refresh session so new MFA freshness is picked up by subsequent calls
      await fetchAdminWhoami(true);
      setCode("");
      onVerified();
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.apiError.code === "ACCOUNT_LOCKED" || err.status === 423) {
          setState({ status: "locked" });
        } else if (err.status === 401) {
          // Session genuinely expired (not just stale MFA)
          setState({ status: "expired" });
        } else if (err.apiError.code === "INVALID_CODE") {
          setState({ status: "error", message: "Invalid code. Try again." });
        } else {
          setState({ status: "error", message: err.apiError.message });
        }
      } else {
        setState({ status: "error", message: "Unexpected error — please try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = state.status === "locked";
  const isExpired = state.status === "expired";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          padding: "12px 16px",
          background: "var(--aiq-color-bg-raised)",
          borderRadius: "var(--aiq-radius-md)",
          border: "1px solid var(--aiq-color-border)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--aiq-color-fg-secondary)",
            lineHeight: 1.5,
          }}
        >
          Your admin MFA needs to be verified before provisioning a new company. Enter
          your 6-digit authenticator code to continue.
        </p>
      </div>

      {state.status === "locked" && (
        <Chip>Too many attempts; locked for 15 minutes.</Chip>
      )}
      {state.status === "expired" && (
        <div>
          <Chip>Your session expired — </Chip>{" "}
          <a
            href="/admin/login"
            style={{ fontSize: 13, color: "var(--aiq-color-accent)", fontWeight: 500 }}
          >
            sign in again.
          </a>
        </div>
      )}
      {state.status === "error" && <Chip>{state.message}</Chip>}

      <div data-help-id="admin.platform.mfa_code">
        <Field
          label="Authenticator code"
          placeholder="000000"
          value={code}
          onChange={(e) => handleInput(e.target.value)}
          disabled={isLocked || isExpired || loading}
          // These attrs go on the underlying <input> via Field's passthrough
          // inputMode and autoComplete are standard HTML attributes Field forwards
        />
        {/* Overlay mono style on the input via a sibling note — Field handles the input element */}
        <span
          style={{
            ...META_LABEL,
            display: "block",
            marginTop: 4,
            fontSize: 10,
          }}
        >
          6 digits · rotates every 30 s
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={() => void verify()}
          loading={loading}
          disabled={code.length !== 6 || isLocked || isExpired}
        >
          Verify &amp; create
        </Button>
      </div>
    </div>
  );
}

// ── Create-company modal ──────────────────────────────────────────────────────

type ModalState = "form" | "mfa";

interface FieldErrors {
  // `string | undefined` (not bare `string?`) so the clear pattern
  // `setFieldErrors(e => ({ ...e, name: undefined }))` typechecks under
  // exactOptionalPropertyTypes.
  name?: string | undefined;
  slug?: string | undefined;
  adminEmail?: string | undefined;
}

function CreateCompanyForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (email: string, expiresAt: string | null) => void;
  onCancel: () => void;
}): React.ReactElement {
  // Form fields — preserved across MFA step-up
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [domain, setDomain] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ email: string; expiresAt: string | null } | null>(null);
  const [modalState, setModalState] = useState<ModalState>("form");

  // Auto-derive slug from name unless user has manually edited it
  const handleNameChange = (value: string): void => {
    setName(value);
    setFieldErrors((e) => ({ ...e, name: undefined }));
    if (!slugManuallyEdited) {
      setSlug(nameToSlug(value));
      setFieldErrors((e) => ({ ...e, slug: undefined }));
    }
  };

  const handleSlugChange = (value: string): void => {
    setSlugManuallyEdited(true);
    setSlug(value);
    setFieldErrors((e) => ({ ...e, slug: undefined }));
  };

  const buildPayload = (): CreateCompanyRequest => {
    const body: CreateCompanyRequest = {
      name: name.trim(),
      slug: slug.trim(),
      adminEmail: adminEmail.trim(),
    };
    if (domain.trim()) body.domain = domain.trim();
    if (adminName.trim()) body.adminName = adminName.trim();
    return body;
  };

  const validateClient = (): boolean => {
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = "Company name is required.";
    if (!slug.trim()) errs.slug = "Slug is required.";
    else if (!SLUG_RE.test(slug.trim())) errs.slug = "Slug may only contain lowercase letters, digits, and hyphens.";
    if (!adminEmail.trim()) errs.adminEmail = "Admin email is required.";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (): Promise<void> => {
    if (!validateClient()) return;
    setLoading(true);
    setGlobalError(null);
    try {
      const res = await createCompanyApi(buildPayload());
      const expiresAt = res.invitation?.expires_at ?? null;
      setToast({ email: res.invitation?.email ?? adminEmail, expiresAt });
      setTimeout(() => {
        setToast(null);
        onSuccess(res.invitation?.email ?? adminEmail, expiresAt);
      }, 1500);
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.status === 401 && /fresh totp/i.test(err.apiError.message)) {
          // Switch to MFA step-up sub-state — do NOT close; preserve form values
          setModalState("mfa");
        } else if (err.status === 409 && err.apiError.details?.code === "TENANT_SLUG_CONFLICT") {
          setFieldErrors((e) => ({ ...e, slug: "That slug is already taken." }));
        } else if (err.status === 400) {
          const code = err.apiError.details?.code as string | undefined;
          if (code === "MISSING_NAME") setFieldErrors((e) => ({ ...e, name: err.apiError.message }));
          else if (code === "INVALID_SLUG") setFieldErrors((e) => ({ ...e, slug: err.apiError.message }));
          else if (code === "MISSING_ADMIN_EMAIL") setFieldErrors((e) => ({ ...e, adminEmail: err.apiError.message }));
          else setGlobalError(err.apiError.message);
        } else {
          setGlobalError(err.apiError.message);
        }
      } else {
        setGlobalError("Unexpected error — please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  // After MFA verified → auto-retry the original create call
  const handleMfaVerified = async (): Promise<void> => {
    setModalState("form");
    setLoading(true);
    setGlobalError(null);
    try {
      const res = await createCompanyApi(buildPayload());
      const expiresAt = res.invitation?.expires_at ?? null;
      setToast({ email: res.invitation?.email ?? adminEmail, expiresAt });
      setTimeout(() => {
        setToast(null);
        onSuccess(res.invitation?.email ?? adminEmail, expiresAt);
      }, 1500);
    } catch (err) {
      if (err instanceof AdminApiError) {
        setGlobalError(err.apiError.message);
      } else {
        setGlobalError("Unexpected error — please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.36)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480 }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
          >
            {modalState === "mfa" ? "Verify MFA" : "Create company"}
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close">
            ×
          </Button>
        </div>

        {modalState === "mfa" ? (
          <MfaStepUp
            onVerified={() => void handleMfaVerified()}
            onCancel={onCancel}
          />
        ) : (
          <>
            <p
              style={{
                fontSize: 13,
                color: "var(--aiq-color-fg-secondary)",
                margin: "0 0 20px",
                lineHeight: 1.5,
              }}
            >
              Provision a new company tenant and invite its first admin. Platform operators only.
            </p>

            {toast && (
              <div style={{ marginBottom: 16 }}>
                <Chip variant="success">
                  Invited {toast.email}
                  {toast.expiresAt ? ` · expires ${formatDate(toast.expiresAt)}` : ""}.
                </Chip>
              </div>
            )}

            {globalError && (
              <div style={{ marginBottom: 16 }}>
                <Chip>{globalError}</Chip>
              </div>
            )}

            <div style={{ display: "grid", gap: 16 }}>
              {/* Company name */}
              <div data-help-id="admin.platform">
                <Field
                  label="Company name"
                  placeholder="Acme Corp"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
                />
              </div>

              {/* Slug */}
              <div data-help-id="admin.platform.slug">
                <Field
                  label="Slug"
                  placeholder="acme-corp"
                  value={slug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                  {...(fieldErrors.slug ? { error: fieldErrors.slug } : {})}
                />
                <span
                  style={{
                    ...META_LABEL,
                    display: "block",
                    marginTop: 4,
                    fontSize: 10,
                  }}
                >
                  Lowercase letters, digits, hyphens · auto-suggested from name
                </span>
              </div>

              {/* First-admin email */}
              <div data-help-id="admin.platform.admin_email">
                <Field
                  label="First-admin email"
                  type="email"
                  placeholder="admin@company.com"
                  value={adminEmail}
                  onChange={(e) => {
                    setAdminEmail(e.target.value);
                    setFieldErrors((fe) => ({ ...fe, adminEmail: undefined }));
                  }}
                  {...(fieldErrors.adminEmail ? { error: fieldErrors.adminEmail } : {})}
                />
              </div>

              {/* Advanced (collapsible) */}
              <div>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((o) => !o)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    ...META_LABEL,
                  }}
                  aria-expanded={advancedOpen}
                >
                  <span style={{ transition: "transform 0.15s", transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>
                    ▶
                  </span>
                  Advanced
                </button>
                {advancedOpen && (
                  <div style={{ display: "grid", gap: 16, marginTop: 12 }}>
                    <div data-help-id="admin.platform.domain">
                      <Field
                        label="Domain (optional)"
                        placeholder="company.com"
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                      />
                    </div>
                    <div data-help-id="admin.platform.admin_name">
                      <Field
                        label="Admin display name (optional)"
                        placeholder="Jane Smith"
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                leftIcon="plus"
                onClick={() => void submit()}
                loading={loading}
                disabled={!!toast}
              >
                Create company
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ── Lifecycle confirmation modal ─────────────────────────────────────────────

const LIFECYCLE_COPY: Record<
  LifecycleAction,
  { title: (name: string) => string; body: (name: string, userCount: number) => string; verb: string }
> = {
  suspend: {
    title: (name) => `Suspend ${name}?`,
    body: (name, count) =>
      `Suspending ${name} will sign out all active users immediately (${count} users) and prevent future logins. All data, billing, and entitlements are preserved. You can resume any time.`,
    verb: "Suspend",
  },
  resume: {
    title: (name) => `Resume ${name}?`,
    body: (name) =>
      `Resuming will allow ${name}'s users to sign in again. They will need to re-authenticate.`,
    verb: "Resume",
  },
  archive: {
    title: (name) => `Archive ${name}?`,
    body: (name) =>
      `Archiving will sign out all active users immediately, prevent future logins, and hide this tenant from the default Platform view. All data is preserved. You can unarchive any time.`,
    verb: "Archive",
  },
  unarchive: {
    title: (name) => `Unarchive ${name}?`,
    body: (name) =>
      `Unarchiving will restore this tenant to active status. Users may sign in again.`,
    verb: "Unarchive",
  },
};

function LifecycleConfirmModal({
  action,
  tenant,
  onConfirm,
  onCancel,
}: {
  action: LifecycleAction;
  tenant: TenantListItem;
  onConfirm: (reason: string | undefined) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const copy = LIFECYCLE_COPY[action];
  const userCount = (tenant.admin_count ?? 0) + (tenant.reviewer_count ?? 0);

  const handleConfirm = async (): Promise<void> => {
    setLoading(true);
    try {
      await onConfirm(reason.trim() || undefined);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.36)",
        display: "grid",
        placeItems: "center",
        zIndex: 300,
      }}
      onClick={onCancel}
      role="presentation"
    >
      <Card
        padding="lg"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480 }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
          >
            {copy.title(tenant.name)}
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close" disabled={loading}>
            ×
          </Button>
        </div>

        <p
          style={{
            fontSize: 13,
            color: "var(--aiq-color-fg-secondary)",
            margin: "0 0 20px",
            lineHeight: 1.5,
          }}
        >
          {copy.body(tenant.name, userCount)}
        </p>

        {/* Optional reason textarea */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 12,
              fontWeight: 500,
              marginBottom: 6,
            }}
          >
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={loading}
            placeholder="Briefly describe why (recorded in the audit log)…"
            rows={3}
            style={{
              width: "100%",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: "var(--aiq-radius-md)",
              border: "1px solid var(--aiq-color-border)",
              background: "var(--aiq-color-bg-raised)",
              color: "var(--aiq-color-fg-primary)",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <span style={{ ...META_LABEL, display: "block", marginTop: 4, fontSize: 10 }}>
            {reason.length} / 500
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => void handleConfirm()} loading={loading}>
            {copy.verb}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Billing drawer ────────────────────────────────────────────────────────────

const TIER_OPTIONS = [
  { value: "free", label: "free" },
  { value: "pro", label: "pro" },
  { value: "enterprise", label: "enterprise" },
  { value: "internal", label: "internal" },
];

function BillingDrawer({
  tenant,
  onClose,
  onPlanUpdated,
}: {
  tenant: TenantListItem;
  onClose: () => void;
  onPlanUpdated: () => void;
}): React.ReactElement {
  // Editing is locked when tenant is not in an active/provisioning state
  const isReadOnly = tenant.status !== "active" && tenant.status !== "provisioning";
  const [detail, setDetail] = useState<TenantBillingDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(true);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  // Plan editor state
  const [editTier, setEditTier] = useState<string>("free");
  const [editCredits, setEditCredits] = useState<string>("25");
  const [planConfirmPending, setPlanConfirmPending] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planAuditId, setPlanAuditId] = useState<string | null>(null);
  const [planToast, setPlanToast] = useState(false);

  // Entitlement state
  const [entitlements, setEntitlements] = useState<TenantEntitlement[]>([]);
  const [entitlementsLoading, setEntitlementsLoading] = useState(true);
  const [entitlementsError, setEntitlementsError] = useState<string | null>(null);
  const grantScopeType = 'domain' as const;
  const [grantScopeId, setGrantScopeId] = useState('');
  const [grantSaving, setGrantSaving] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantToastAuditId, setGrantToastAuditId] = useState<string | null>(null);
  const [revokeSaving, setRevokeSaving] = useState<string | null>(null); // entitlement id being revoked
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Responsive: full-screen on mobile (≤640px), right-panel on desktop
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Content-scopes state (D1/D2) — for dropdown grant form
  const [contentScopes, setContentScopes] = useState<TenantContentScopes | null>(null);
  const [contentScopesError, setContentScopesError] = useState<string | null>(null);

  const fetchEntitlements = (): void => {
    setEntitlementsLoading(true);
    setEntitlementsError(null);
    void getTenantEntitlements(tenant.id)
      .then((d) => {
        setEntitlements(d.entitlements);
      })
      .catch((err) => {
        setEntitlementsError(err instanceof AdminApiError ? err.apiError.message : "Failed to load entitlements.");
      })
      .finally(() => {
        setEntitlementsLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;
    setDrawerLoading(true);
    setDrawerError(null);
    void getTenantBillingDetail(tenant.id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setEditTier(d.tier);
        setEditCredits(d.included_credits !== null ? String(d.included_credits) : "");
      })
      .catch((err) => {
        if (cancelled) return;
        setDrawerError(err instanceof AdminApiError ? err.apiError.message : "Failed to load billing detail.");
      })
      .finally(() => {
        if (!cancelled) setDrawerLoading(false);
      });
    return () => { cancelled = true; };
  }, [tenant.id]);

  useEffect(() => {
    fetchEntitlements();
    // Also fetch content-scopes for the grant dropdown (D1/D2)
    setContentScopesError(null);
    void getTenantContentScopes(tenant.id)
      .then((s) => setContentScopes(s))
      .catch((err) => {
        setContentScopesError(err instanceof AdminApiError ? err.apiError.message : "couldn't load list — type manually");
      });
  }, [tenant.id]);

  const isInternalTier = editTier === "internal";

  const handleGrantEntitlement = async (): Promise<void> => {
    if (!grantScopeId.trim()) return;
    setGrantSaving(true);
    setGrantError(null);
    setGrantToastAuditId(null);
    try {
      const res = await grantTenantEntitlement(tenant.id, { scopeType: grantScopeType, scopeId: grantScopeId.trim() });
      setGrantToastAuditId(res.auditId);
      setGrantScopeId('');
      setTimeout(() => setGrantToastAuditId(null), 8_000);
      fetchEntitlements();
    } catch (err) {
      setGrantError(err instanceof AdminApiError ? err.apiError.message : "Grant failed — please try again.");
    } finally {
      setGrantSaving(false);
    }
  };

  const handleRevokeEntitlement = async (ent: TenantEntitlement): Promise<void> => {
    setRevokeSaving(ent.id);
    setRevokeError(null);
    try {
      await revokeTenantEntitlement(tenant.id, { scopeType: ent.scope_type, scopeId: ent.scope_id });
      fetchEntitlements();
    } catch (err) {
      setRevokeError(err instanceof AdminApiError ? err.apiError.message : "Revoke failed — please try again.");
    } finally {
      setRevokeSaving(null);
    }
  };

  const handleSavePlan = async (): Promise<void> => {
    setPlanSaving(true);
    setPlanError(null);
    try {
      const includedCredits = isInternalTier ? null : parseInt(editCredits, 10);
      const res = await updateTenantPlan(tenant.id, {
        tier: editTier,
        includedCredits,
      });
      setPlanAuditId(res.auditId);
      setPlanToast(true);
      setPlanConfirmPending(false);
      setTimeout(() => setPlanToast(false), 8_000);
      onPlanUpdated();
    } catch (err) {
      if (err instanceof AdminApiError) {
        const code = err.apiError.details?.code as string | undefined;
        setPlanError(
          code === "INTERNAL_REQUIRES_NULL_CREDITS"
            ? "Internal tier requires credits to be blank (unlimited)."
            : code === "FINITE_TIER_REQUIRES_CREDITS"
              ? "This tier requires a finite credits value."
              : err.apiError.message,
        );
      } else {
        setPlanError("Save failed — please try again.");
      }
      setPlanConfirmPending(false);
    } finally {
      setPlanSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 200,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={isMobile ? {
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100dvh",
          maxWidth: "100vw",
          borderRadius: 0,
          overflowY: "auto",
          background: "var(--aiq-color-bg-base)",
          padding: "var(--aiq-space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-lg)",
        } : {
          width: "min(720px, 92vw)",
          height: "100%",
          overflowY: "auto",
          background: "var(--aiq-color-bg-base)",
          borderLeft: "1px solid var(--aiq-color-border)",
          padding: "var(--aiq-space-xl)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer header — sticky on mobile so close button is always reachable */}
        <div style={{
          display: "flex",
          alignItems: "center",
          ...(isMobile ? {
            position: "sticky",
            top: 0,
            background: "var(--aiq-color-bg-base)",
            zIndex: 1,
            marginTop: "calc(-1 * var(--aiq-space-xl))",
            marginLeft: "calc(-1 * var(--aiq-space-xl))",
            marginRight: "calc(-1 * var(--aiq-space-xl))",
            padding: "var(--aiq-space-md) var(--aiq-space-xl)",
            borderBottom: "1px solid var(--aiq-color-border)",
          } : {}),
        }}>
          <div>
            <div style={{ ...META_LABEL, fontSize: 10 }}>Billing — {tenant.slug}</div>
            <h2
              className="aiq-serif"
              style={{ fontSize: 20, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
            >
              {tenant.name}
            </h2>
          </div>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close drawer">
            ×
          </Button>
        </div>

        {/* Read-only banner — shown when tenant is suspended or archived */}
        {isReadOnly && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--aiq-color-bg-sunken)",
              borderRadius: "var(--aiq-radius-md)",
              border: "1px solid var(--aiq-color-border)",
              fontSize: 13,
              color: "var(--aiq-color-fg-secondary)",
              lineHeight: 1.5,
            }}
          >
            This tenant is <strong>{tenant.status}</strong>. Configuration is read-only.
          </div>
        )}

        {drawerLoading && (
          <div style={{ display: "grid", placeItems: "center", padding: 40 }}>
            <Spinner aria-label="Loading billing detail" />
          </div>
        )}

        {drawerError && !drawerLoading && (
          <Chip>{drawerError}</Chip>
        )}

        {detail !== null && !drawerLoading && (
          <>
            {/* Read-only stats */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                {/* Section heading with HelpTip — admin.platform.billing */}
                <div style={{ display: "flex", alignItems: "center" }}>
                  <HelpTip helpId="admin.platform.billing">
                    <span style={{ ...META_LABEL, fontSize: 10 }}>Usage &amp; plan</span>
                  </HelpTip>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--aiq-space-md)" }}>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Tier</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0", textTransform: "capitalize" }}>
                    {detail.tier}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Included credits</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.included_credits !== null ? detail.included_credits : "Unlimited"}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Used</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.used}
                  </p>
                </div>
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Remaining</p>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0" }}>
                    {detail.remaining !== null ? detail.remaining : "Unlimited"}
                  </p>
                </div>
                {detail.overage > 0 && (
                  <div>
                    <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Overage</p>
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 14, fontWeight: 600, margin: "4px 0 0", color: "var(--aiq-color-danger, #dc2626)" }}>
                      +{detail.overage}
                    </p>
                  </div>
                )}
                <div>
                  <p style={{ ...META_LABEL, display: "block", fontSize: 10 }}>Cycle start</p>
                  <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12, margin: "4px 0 0", color: "var(--aiq-color-fg-muted)" }}>
                    {formatDate(detail.cycle_start)}
                  </p>
                </div>
                </div>{/* end inner grid */}
              </div>{/* end outer flex column */}
            </Card>

            {/* Recent events */}
            {detail.recent_events.length > 0 && (
              <div>
                <div style={{ ...META_LABEL, fontSize: 10, marginBottom: 8 }}>
                  Recent events ({detail.recent_events.length})
                </div>
                <div
                  style={{
                    border: "1px solid var(--aiq-color-border)",
                    borderRadius: "var(--aiq-radius-md)",
                    overflow: "hidden",
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  {detail.recent_events.map((ev) => (
                    <div
                      key={ev.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--aiq-color-border)",
                        fontSize: 11,
                        fontFamily: "var(--aiq-font-mono)",
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ev.attempt_id}>
                        {ev.attempt_id.slice(0, 8)}…
                      </span>
                      <span style={{ textAlign: "right" }}>
                        {new Date(ev.occurred_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CSV download */}
            <div>
              <a
                href={tenantBillingCsvUrl(tenant.id)}
                download
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: 13,
                  color: "var(--aiq-color-accent)",
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                Download CSV
              </a>
            </div>

            {/* Plan editor */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                <div style={{ ...META_LABEL, fontSize: 10 }}>Edit plan</div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label
                    htmlFor={`tier-select-${tenant.id}`}
                    style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                  >
                    Tier
                  </label>
                  <select
                    id={`tier-select-${tenant.id}`}
                    value={editTier}
                    onChange={(e) => {
                      setEditTier(e.target.value);
                      if (e.target.value === "internal") setEditCredits("");
                      setPlanError(null);
                    }}
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border)",
                      background: "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      width: "100%",
                    }}
                  >
                    {TIER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label
                    htmlFor={`credits-input-${tenant.id}`}
                    style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                  >
                    Included credits {isInternalTier && "(disabled — internal tier is unlimited)"}
                  </label>
                  <input
                    id={`credits-input-${tenant.id}`}
                    type="number"
                    min={0}
                    value={isInternalTier ? "" : editCredits}
                    disabled={isInternalTier}
                    onChange={(e) => { setEditCredits(e.target.value); setPlanError(null); }}
                    placeholder={isInternalTier ? "Unlimited" : "e.g. 25"}
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-border)",
                      background: isInternalTier
                        ? "var(--aiq-color-bg-sunken)"
                        : "var(--aiq-color-bg-raised)",
                      color: "var(--aiq-color-fg-primary)",
                      width: "100%",
                      opacity: isInternalTier ? 0.5 : 1,
                    }}
                  />
                </div>

                {planError !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {planError}
                  </p>
                )}

                {planToast && planAuditId !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-success, #16a34a)", margin: 0 }}>
                    Plan updated. Audit: {planAuditId}
                  </p>
                )}

                {planConfirmPending ? (
                  <div
                    style={{
                      padding: "var(--aiq-space-md)",
                      background: "var(--aiq-color-bg-sunken)",
                      borderRadius: "var(--aiq-radius-md)",
                      border: "1px solid var(--aiq-color-warning, #d97706)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, margin: 0 }}>
                      Update plan to <strong>{editTier}</strong>
                      {!isInternalTier ? ` / ${editCredits} credits` : " (unlimited)"}?
                      This change is audit-logged.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-primary aiq-btn-sm"
                        disabled={planSaving || isReadOnly}
                        onClick={() => void handleSavePlan()}
                      >
                        {planSaving ? "Saving…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-outline aiq-btn-sm"
                        disabled={planSaving}
                        onClick={() => setPlanConfirmPending(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary aiq-btn-sm"
                    disabled={isReadOnly}
                    onClick={() => { setPlanConfirmPending(true); setPlanError(null); }}
                  >
                    Save
                  </button>
                )}
              </div>
            </Card>
            {/* Entitlements subsection — B1 */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <HelpTip helpId="admin.platform.entitlements">
                    <span style={{ ...META_LABEL, fontSize: 10 }}>Entitlements</span>
                  </HelpTip>
                </div>

                {/* Active entitlements list */}
                {entitlementsLoading && (
                  <div style={{ display: "grid", placeItems: "center", padding: 16 }}>
                    <Spinner aria-label="Loading entitlements" />
                  </div>
                )}
                {entitlementsError && !entitlementsLoading && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {entitlementsError}
                  </p>
                )}
                {!entitlementsLoading && !entitlementsError && (
                  <>
                    {entitlements.filter((e) => e.status === 'active').length === 0 ? (
                      <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                        No active entitlements.
                      </p>
                    ) : (
                      <div
                        style={{
                          border: "1px solid var(--aiq-color-border)",
                          borderRadius: "var(--aiq-radius-md)",
                          overflow: "hidden",
                        }}
                      >
                        {entitlements
                          .filter((e) => e.status === 'active')
                          .map((ent) => (
                            <div
                              key={ent.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 12px",
                                borderBottom: "1px solid var(--aiq-color-border)",
                                fontSize: 12,
                                fontFamily: "var(--aiq-font-sans)",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: 10,
                                  padding: "2px 6px",
                                  background: "var(--aiq-color-bg-sunken)",
                                  borderRadius: "var(--aiq-radius-sm)",
                                  color: "var(--aiq-color-fg-secondary)",
                                  flexShrink: 0,
                                }}
                              >
                                {ent.scope_type}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  fontFamily: "var(--aiq-font-mono)",
                                  fontSize: 12,
                                  color: "var(--aiq-color-fg-primary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={ent.scope_id}
                              >
                                {ent.scope_id}
                              </span>
                              <button
                                type="button"
                                className="aiq-btn aiq-btn-outline aiq-btn-sm"
                                disabled={revokeSaving === ent.id || isReadOnly}
                                onClick={() => void handleRevokeEntitlement(ent)}
                                style={{ flexShrink: 0 }}
                              >
                                {revokeSaving === ent.id ? "Revoking…" : "Revoke"}
                              </button>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                )}

                {revokeError !== null && (
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                    {revokeError}
                  </p>
                )}

                {/* Grant form — domain by default; pack behind Advanced disclosure */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>

                  {/* Domain scope (default, always visible) */}
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      <label
                        style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500 }}
                      >
                        Domain
                      </label>
                      {/* D2: dropdown from content-scopes when available; fallback to free-text */}
                      {contentScopes !== null && !contentScopesError ? (
                        <select
                          value={grantScopeId}
                          onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                          disabled={grantSaving}
                          style={{
                            fontFamily: "var(--aiq-font-mono)",
                            fontSize: 12,
                            padding: "5px 8px",
                            borderRadius: "var(--aiq-radius-md)",
                            border: "1px solid var(--aiq-color-border)",
                            background: "var(--aiq-color-bg-raised)",
                            color: "var(--aiq-color-fg-primary)",
                            width: "100%",
                          }}
                        >
                          <option value="">— Select domain —</option>
                          {contentScopes.domains
                            .filter((d) => !entitlements.some((e) => e.status === 'active' && e.scope_type === 'domain' && e.scope_id === d))
                            .map((d) => <option key={d} value={d}>{d}</option>)
                          }
                        </select>
                      ) : (
                        <>
                          <input
                            type="text"
                            value={grantScopeId}
                            onChange={(e) => { setGrantScopeId(e.target.value); setGrantError(null); }}
                            placeholder="e.g. soc"
                            disabled={grantSaving}
                            style={{
                              fontFamily: "var(--aiq-font-mono)",
                              fontSize: 12,
                              padding: "5px 8px",
                              borderRadius: "var(--aiq-radius-md)",
                              border: "1px solid var(--aiq-color-border)",
                              background: "var(--aiq-color-bg-raised)",
                              color: "var(--aiq-color-fg-primary)",
                              width: "100%",
                            }}
                          />
                          {contentScopesError !== null && (
                            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 10, color: "var(--aiq-color-fg-muted)" }}>
                              {contentScopesError}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="aiq-btn aiq-btn-primary aiq-btn-sm"
                      disabled={grantSaving || !grantScopeId.trim() || isReadOnly}
                      onClick={() => void handleGrantEntitlement()}
                      style={{ flexShrink: 0 }}
                    >
                      {grantSaving ? "Granting…" : "Grant"}
                    </button>
                  </div>
                  <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 11, color: "var(--aiq-color-fg-muted)", margin: 0 }}>
                    Granting a subject domain lets this company use every question pack in it.
                  </p>

                  {grantError !== null && (
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>
                      {grantError}
                    </p>
                  )}

                  {grantToastAuditId !== null && (
                    <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-success, #16a34a)", margin: 0 }}>
                      Granted. Audit: {grantToastAuditId}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// ── Per-row Manage menu ───────────────────────────────────────────────────────

function ManageMenu({
  tenant,
  onOpenBilling,
  onLifecycleAction,
}: {
  tenant: TenantListItem;
  onOpenBilling: () => void;
  onLifecycleAction: (action: LifecycleAction) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  // Portal-anchored dropdown — same reason as users.tsx: parent table uses
  // overflow:hidden for rounded corners, which clips an absolutely-positioned
  // dropdown on the last row. Render to document.body via createPortal,
  // anchored via getBoundingClientRect, position:fixed. Closes on outside
  // click or any scroll/resize.
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    if (triggerRef.current === null) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });

    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onScrollOrResize = (): void => setOpen(false);

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const menuItem = (label: string, onClick: () => void, danger = false): React.ReactElement => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
        onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 14px",
        background: "none",
        border: "none",
        cursor: "pointer",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: 13,
        color: danger ? "var(--aiq-color-danger, #dc2626)" : "var(--aiq-color-fg-primary)",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--aiq-color-bg-sunken)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "none"; }}
    >
      {label}
    </button>
  );

  const lifecycleItems: React.ReactElement[] = [];
  if (tenant.status === "active") {
    lifecycleItems.push(menuItem("Suspend tenant", () => onLifecycleAction("suspend"), true));
    lifecycleItems.push(menuItem("Archive tenant", () => onLifecycleAction("archive"), true));
  } else if (tenant.status === "suspended") {
    lifecycleItems.push(menuItem("Resume tenant", () => onLifecycleAction("resume")));
    lifecycleItems.push(menuItem("Archive tenant", () => onLifecycleAction("archive"), true));
  } else if (tenant.status === "archived") {
    lifecycleItems.push(menuItem("Unarchive tenant", () => onLifecycleAction("unarchive")));
  } else if (tenant.status === "provisioning") {
    lifecycleItems.push(
      <div
        key="provisioning"
        style={{
          padding: "7px 14px",
          fontFamily: "var(--aiq-font-sans)",
          fontSize: 12,
          color: "var(--aiq-color-fg-muted)",
        }}
      >
        Provisioning in progress
      </div>,
    );
  }

  return (
    <>
      <div ref={triggerRef} style={{ position: "relative", display: "inline-block" }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          Manage ▾
        </Button>
      </div>
      {open && coords !== null &&
        createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            top: coords.top,
            right: coords.right,
            background: "var(--aiq-color-bg-base, #ffffff)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-md)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 1000,
            minWidth: 180,
            paddingTop: 4,
            paddingBottom: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItem("Open billing", () => { onOpenBilling(); })}
          {menuItem("Manage users", () => { navigate(`/admin/platform/${tenant.id}/users`); })}
          {lifecycleItems.length > 0 && (
            <div
              style={{
                height: 1,
                background: "var(--aiq-color-border)",
                margin: "4px 0",
              }}
            />
          )}
          {lifecycleItems}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminPlatform(): React.ReactElement {
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [drawerTenant, setDrawerTenant] = useState<TenantListItem | null>(null);
  const [resendingTenantId, setResendingTenantId] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendToast, setResendToast] = useState<string | null>(null);

  // Phase B: Show archived toggle (session-scoped, default false)
  const [includeArchived, setIncludeArchived] = useState(false);

  // Phase B: Lifecycle modal + action state
  const [lifecycleModal, setLifecycleModal] = useState<LifecycleModalState | null>(null);
  const [lifecycleToast, setLifecycleToast] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const fetchTenants = useCallback(async (archived = includeArchived): Promise<void> => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await listTenantsApi({ includeArchived: archived });
      setTenants(data.tenants);
    } catch (err) {
      if (err instanceof AdminApiError) {
        setFetchError(err.apiError.message);
      } else {
        setFetchError("Failed to load tenants.");
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchTenants(includeArchived);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchTenants, includeArchived]);

  const handleResend = async (tenantId: string): Promise<void> => {
    setResendingTenantId(tenantId);
    setResendError(null);
    setResendToast(null);
    try {
      const res = await resendInvitationApi(tenantId);
      setResendToast(
        `Resent invite to ${res.invitation.email} · expires ${formatDate(res.invitation.expires_at)}`,
      );
      setTimeout(() => setResendToast(null), 4000);
      void fetchTenants(includeArchived);
    } catch (err) {
      setResendError(
        err instanceof AdminApiError ? err.apiError.message : "Resend failed — please try again.",
      );
    } finally {
      setResendingTenantId(null);
    }
  };

  // Phase B: Lifecycle action handler — called by LifecycleConfirmModal.onConfirm
  const handleLifecycleConfirm = async (
    action: LifecycleAction,
    tenant: TenantListItem,
    reason: string | undefined,
  ): Promise<void> => {
    setLifecycleError(null);
    setLifecycleToast(null);
    const apiMap: Record<LifecycleAction, (id: string, r?: string) => Promise<LifecycleResponse>> = {
      suspend: suspendTenantApi,
      resume: resumeTenantApi,
      archive: archiveTenantApi,
      unarchive: unarchiveTenantApi,
    };
    const verb = LIFECYCLE_COPY[action].verb;
    try {
      const res = await apiMap[action](tenant.id, reason);
      setLifecycleModal(null);
      if (res.noOp) {
        setLifecycleToast(`${verb} ${tenant.name} — already in target state`);
      } else {
        const revoked = res.sessionsRevoked?.count ?? 0;
        setLifecycleToast(`${verb} ${tenant.name} — ${revoked} user${revoked !== 1 ? "s" : ""} signed out`);
      }
      setTimeout(() => setLifecycleToast(null), 4000);
      void fetchTenants(includeArchived);
    } catch (err) {
      if (err instanceof AdminApiError) {
        const details = err.apiError.details as Record<string, unknown> | undefined;
        if (details?.code === "INVALID_LIFECYCLE_TRANSITION") {
          const current = details.currentStatus as string | undefined;
          setLifecycleError(
            `${tenant.name} is in ${current ?? "unknown"} state and cannot be ${verb.toLowerCase()}d`,
          );
        } else {
          setLifecycleError(err.apiError.message);
        }
      } else {
        setLifecycleError("Unexpected error — please try again.");
      }
      // Keep modal closed on error; error shows at page level
      setLifecycleModal(null);
    }
  };

  // Updated ROW_GRID to accommodate Manage column at end
  const ROW_GRID_WITH_MANAGE = `${ROW_GRID} 120px`;

  return (
    <AdminShell breadcrumbs={["Platform"]} helpPage="admin.platform">
      {showCreate && (
        <CreateCompanyForm
          onSuccess={() => {
            setShowCreate(false);
            void fetchTenants(includeArchived);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {drawerTenant !== null && (
        <BillingDrawer
          tenant={drawerTenant}
          onClose={() => setDrawerTenant(null)}
          onPlanUpdated={() => void fetchTenants(includeArchived)}
        />
      )}

      {lifecycleModal !== null && (
        <LifecycleConfirmModal
          action={lifecycleModal.action}
          tenant={lifecycleModal.tenant}
          onConfirm={(reason) =>
            handleLifecycleConfirm(lifecycleModal.action, lifecycleModal.tenant, reason)
          }
          onCancel={() => setLifecycleModal(null)}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count Chip + serif h1 + lede + CTA */}
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip leftIcon="grid">{tenants.length} companies</Chip>
            </div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.02em",
              }}
            >
              Companies.
            </h1>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 0",
                maxWidth: 520,
                lineHeight: 1.5,
              }}
            >
              Provision a new company tenant and invite its first admin. Platform operators only.
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <Button leftIcon="plus" onClick={() => setShowCreate(true)}>
            Create company
          </Button>
        </div>

        {/* Error state */}
        {fetchError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{fetchError}</Chip>
          </div>
        )}
        {resendError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{resendError}</Chip>
          </div>
        )}
        {resendToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{resendToast}</Chip>
          </div>
        )}
        {/* Phase B: lifecycle action toast / error */}
        {lifecycleToast && (
          <div style={{ marginBottom: 16 }}>
            <Chip variant="success">{lifecycleToast}</Chip>
          </div>
        )}
        {lifecycleError && (
          <div style={{ marginBottom: 16 }}>
            <Chip>{lifecycleError}</Chip>
          </div>
        )}

        {/* Phase B: Show archived toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              userSelect: "none",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: 13,
              color: "var(--aiq-color-fg-secondary)",
            }}
          >
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Show archived tenants
          </label>
        </div>

        {/* Data rows or loading / empty */}
        {loading ? (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
            <Spinner aria-label="Loading tenants" />
          </div>
        ) : tenants.length === 0 ? (
          /* Empty state — serif headline + secondary copy + primary CTA (mirrors users.tsx) */
          <div
            style={{
              padding: 64,
              textAlign: "center",
              border: "1px dashed var(--aiq-color-border-strong)",
              borderRadius: "var(--aiq-radius-lg)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <h2
              className="aiq-serif"
              style={{ fontSize: 24, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}
            >
              No companies yet.
            </h2>
            <p
              style={{
                fontSize: 14,
                color: "var(--aiq-color-fg-secondary)",
                margin: "8px 0 20px",
                maxWidth: 360,
                marginLeft: "auto",
                marginRight: "auto",
                lineHeight: 1.5,
              }}
            >
              Provision your first company tenant to get started.
            </p>
            <Button leftIcon="plus" onClick={() => setShowCreate(true)}>
              Create company
            </Button>
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              overflow: "hidden",
              background: "var(--aiq-color-bg-base)",
            }}
          >
            {/* Column heads */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: ROW_GRID_WITH_MANAGE,
                gap: ROW_GRID_GAP,
                padding: "12px 20px",
                background: "var(--aiq-color-bg-raised)",
                borderBottom: "1px solid var(--aiq-color-border)",
                ...META_LABEL,
                fontSize: 10,
              }}
            >
              <span>Slug</span>
              <span>Name</span>
              <span>Primary contact</span>
              <span>Usage</span>
              <span>Tenant</span>
              <span>Created</span>
              <span></span>
            </div>
            {tenants.map((t, i) => {
              const isArchived = t.status === "archived";
              return (
                <div
                  key={t.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: ROW_GRID_WITH_MANAGE,
                    gap: ROW_GRID_GAP,
                    padding: ROW_PADDING,
                    alignItems: "center",
                    borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                    background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                    opacity: isArchived ? 0.7 : 1,
                  }}
                >
                  {/* Slug — mono, strikethrough on archived */}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 12,
                      color: "var(--aiq-color-fg-secondary)",
                      textDecoration: isArchived ? "line-through" : "none",
                    }}
                  >
                    {t.slug}
                  </span>
                  {/* Name — strikethrough on archived */}
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--aiq-color-fg-primary)",
                      textDecoration: isArchived ? "line-through" : "none",
                    }}
                  >
                    {t.name}
                  </span>
                  {/* Primary contact — email (+ name secondary), pending/active hint + Phase B count badge */}
                  <div style={{ minWidth: 0 }}>
                    {t.admin_email === null ? (
                      <span
                        style={{
                          fontSize: 13,
                          color: "var(--aiq-color-fg-muted)",
                        }}
                      >
                        —
                      </span>
                    ) : (
                      <>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--aiq-color-fg-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={t.admin_email}
                        >
                          {t.admin_email}
                        </div>
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                          {t.admin_status === "pending" ? (
                            <>
                              <Chip variant="warn" leftIcon="clock">Invite pending</Chip>
                              {t.admin_invitation_expires_at !== null && (
                                <span
                                  style={{
                                    fontFamily: "var(--aiq-font-mono)",
                                    fontSize: 10,
                                    color: "var(--aiq-color-fg-muted)",
                                  }}
                                >
                                  · expires {formatDate(t.admin_invitation_expires_at)}
                                </span>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={resendingTenantId === t.id}
                                disabled={resendingTenantId !== null}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleResend(t.id);
                                }}
                              >
                                {resendingTenantId === t.id ? "Resending…" : "Resend invite"}
                              </Button>
                            </>
                          ) : t.admin_status === "active" ? (
                            <>
                              {t.admin_name && t.admin_name !== t.admin_email && (
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: "var(--aiq-color-fg-secondary)",
                                  }}
                                >
                                  {t.admin_name}
                                </span>
                              )}
                              <Chip variant="success" leftIcon="check">Accepted</Chip>
                            </>
                          ) : (
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--aiq-color-fg-secondary)",
                              }}
                            >
                              {t.admin_name && t.admin_name !== t.admin_email
                                ? `${t.admin_name} · `
                                : ""}
                              {t.admin_status ?? ""}
                            </span>
                          )}
                        </div>
                        {/* Phase B: admin/reviewer count badge */}
                        {((t.admin_count ?? 0) > 0 || (t.reviewer_count ?? 0) > 0) && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ ...META_LABEL, fontSize: 10 }}>
                              {t.admin_count ?? 0} admin{(t.admin_count ?? 0) !== 1 ? "s" : ""} · {t.reviewer_count ?? 0} reviewer{(t.reviewer_count ?? 0) !== 1 ? "s" : ""}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {/* Usage — A2 */}
                  <span>
                    {t.usage === null || t.usage === undefined ? (
                      <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-muted)" }}>—</span>
                    ) : t.usage.status === "unlimited" ? (
                      <Chip>Unlimited</Chip>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-secondary)" }}>
                          {t.usage.used} / {t.usage.included_credits}
                        </span>
                        {t.usage.overage > 0 && (
                          <Chip variant="warn" style={{ fontSize: 10 }}>+{t.usage.overage}</Chip>
                        )}
                        {t.usage.overage === 0 && t.usage.status === "warn" && (
                          <Chip style={{ fontSize: 10 }}>Near limit</Chip>
                        )}
                      </span>
                    )}
                  </span>
                  {/* Status chip — Phase B: archived gets strikethrough label */}
                  <span>
                    {t.status === "archived" ? (
                      <Chip variant="default">
                        <span style={{ textDecoration: "line-through" }}>archived</span>
                      </Chip>
                    ) : (
                      <Chip variant={statusVariant(t.status)}>{t.status}</Chip>
                    )}
                  </span>
                  {/* Created — mono, en-GB */}
                  <span
                    style={{
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 11,
                      color: "var(--aiq-color-fg-muted)",
                    }}
                  >
                    {formatDate(t.created_at)}
                  </span>
                  {/* Phase B: Manage menu */}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <ManageMenu
                      tenant={t}
                      onOpenBilling={() => setDrawerTenant(t)}
                      onLifecycleAction={(action) => setLifecycleModal({ action, tenant: t })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
