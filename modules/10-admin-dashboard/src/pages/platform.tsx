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
import { Button, Card, Chip, Field, Spinner } from "@assessiq/ui-system";
import type { ChipVariant } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import {
  adminApi,
  AdminApiError,
  createCompanyApi,
  listTenantsApi,
  verifyTotpApi,
  type CreateCompanyRequest,
  type TenantListItem,
} from "../api.js";
import { fetchAdminWhoami } from "../session.js";

// ── Types ────────────────────────────────────────────────────────────────────

type TenantStatus = "active" | "provisioning" | string;

const STATUS_VARIANT: Record<string, ChipVariant> = {
  active: "success",
  provisioning: "accent",
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

const ROW_GRID = "1fr 1.4fr 1.8fr 110px 110px";
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

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminPlatform(): React.ReactElement {
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchTenants = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await listTenantsApi();
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
  }, []);

  useEffect(() => {
    void fetchTenants();
  }, [fetchTenants]);

  return (
    <AdminShell breadcrumbs={["Platform"]} helpPage="admin.platform">
      {showCreate && (
        <CreateCompanyForm
          onSuccess={() => {
            setShowCreate(false);
            void fetchTenants();
          }}
          onCancel={() => setShowCreate(false)}
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
                gridTemplateColumns: ROW_GRID,
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
              <span>First admin</span>
              <span>Status</span>
              <span>Created</span>
            </div>
            {tenants.map((t, i) => (
              <div
                key={t.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: ROW_GRID,
                  gap: ROW_GRID_GAP,
                  padding: ROW_PADDING,
                  alignItems: "center",
                  borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)",
                  background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent",
                }}
              >
                {/* Slug — mono */}
                <span
                  style={{
                    fontFamily: "var(--aiq-font-mono)",
                    fontSize: 12,
                    color: "var(--aiq-color-fg-secondary)",
                  }}
                >
                  {t.slug}
                </span>
                {/* Name */}
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "var(--aiq-color-fg-primary)",
                  }}
                >
                  {t.name}
                </span>
                {/* First admin — email (+ name secondary), pending/active hint */}
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
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--aiq-color-fg-secondary)",
                          marginTop: 2,
                        }}
                      >
                        {t.admin_name && t.admin_name !== t.admin_email
                          ? `${t.admin_name} · `
                          : ""}
                        {t.admin_status === "pending"
                          ? "invite pending"
                          : t.admin_status === "active"
                            ? "accepted"
                            : (t.admin_status ?? "")}
                      </div>
                    </>
                  )}
                </div>
                {/* Status chip */}
                <span>
                  <Chip variant={statusVariant(t.status)}>{t.status}</Chip>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
