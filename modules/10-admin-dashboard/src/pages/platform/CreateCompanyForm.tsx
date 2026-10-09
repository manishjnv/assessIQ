// CreateCompanyForm — split from platform.tsx (E9, no behaviour change).

import React, { useState } from "react";
import { Button, Card, Chip, Field } from "@assessiq/ui-system";
import { MfaStepUp } from "../../components/mfa-step-up.js";
import { AdminApiError, createCompanyApi, type CreateCompanyRequest } from "../../api.js";
import { META_LABEL, formatDate, type ModalState } from "./shared.js";

// ── Slug utils ────────────────────────────────────────────────────────────────

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const SLUG_RE = /^[a-z0-9-]+$/;
// ── Create-company modal ──────────────────────────────────────────────────────


interface FieldErrors {
  // `string | undefined` (not bare `string?`) so the clear pattern
  // `setFieldErrors(e => ({ ...e, name: undefined }))` typechecks under
  // exactOptionalPropertyTypes.
  name?: string | undefined;
  slug?: string | undefined;
  adminEmail?: string | undefined;
}

export function CreateCompanyForm({
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
    if (!name.trim()) errs.name = "Organisation name is required.";
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
            {modalState === "mfa" ? "Verify MFA" : "Create organisation"}
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
              Provision a new organisation and invite its first admin. Platform operators only.
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
                  label="Organisation name"
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
                  placeholder="admin@example.com"
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
                        placeholder="example.com"
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
                Create organisation
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
