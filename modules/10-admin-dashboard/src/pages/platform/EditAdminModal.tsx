// EditAdminModal — split from platform.tsx (E9, no behaviour change).

import React, { useState } from "react";
import { Button, Card, Chip, Field } from "@assessiq/ui-system";
import { MfaStepUp } from "../../components/mfa-step-up.js";
import { AdminApiError, superUpdateAdminApi, superUpdateTenantApi, type SuperUpdateAdminRequest, type TenantListItem } from "../../api.js";
import { META_LABEL, type ModalState } from "./shared.js";

// ── Edit-admin modal ──────────────────────────────────────────────────────────

const normEmail = (s: string): string => s.trim().toLowerCase();

interface EditAdminFieldErrors {
  orgName?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
}

export function EditAdminModal({
  tenant,
  onSuccess,
  onCancel,
}: {
  tenant: TenantListItem;
  onSuccess: (summary: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const adminUserId = tenant.admin_user_id ?? "";
  // "Has an account" = active OR disabled (both have a real login identity, so
  // changing the email transfers it). Only a never-logged-in 'pending' invite is
  // free to re-address. Mirrors the server's identity-confirm gate.
  const hasAccount = tenant.admin_status !== "pending";

  const origOrgName = tenant.name ?? "";
  const origName = tenant.admin_name ?? "";
  const origEmail = normEmail(tenant.admin_email ?? "");

  const [orgName, setOrgName] = useState(origOrgName);
  const [name, setName] = useState(origName);
  const [email, setEmail] = useState(tenant.admin_email ?? "");
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [reason, setReason] = useState("");

  const [fieldErrors, setFieldErrors] = useState<EditAdminFieldErrors>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalState, setModalState] = useState<ModalState>("form");

  const orgNameChanged = orgName.trim() !== origOrgName.trim();
  const emailChanged = normEmail(email) !== origEmail;
  const nameChanged = name.trim() !== origName;
  const adminChanged = emailChanged || nameChanged;
  const hasChanges = orgNameChanged || adminChanged;

  // Identity-transfer gate: changing the email of an existing account (active or
  // disabled) needs explicit confirm.
  const needsIdentityConfirm = hasAccount && emailChanged;
  const identityBlocked = needsIdentityConfirm && !confirmIdentity;

  const buildPayload = (): SuperUpdateAdminRequest => {
    const body: SuperUpdateAdminRequest = {};
    if (nameChanged) body.name = name.trim();
    if (emailChanged) {
      body.email = email.trim();
      if (hasAccount) body.confirmEmailIdentityChange = true;
    }
    if (reason.trim()) body.reason = reason.trim();
    return body;
  };

  const validateClient = (): boolean => {
    const errs: EditAdminFieldErrors = {};
    if (!orgName.trim()) errs.orgName = "Organisation name is required.";
    if (!name.trim()) errs.name = "Name is required.";
    if (!email.trim()) errs.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "Enter a valid email address.";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const doSubmit = async (): Promise<void> => {
    setLoading(true);
    setGlobalError(null);
    try {
      const summaryBits: string[] = [];
      // 1. Company rename. Idempotent server-side — a no-op name returns noOp:true,
      //    so a post-MFA retry that re-sends the same name is harmless.
      if (orgNameChanged) {
        const tRes = await superUpdateTenantApi(tenant.id, { name: orgName.trim() });
        if (!tRes.noOp) summaryBits.push(`renamed → ${tRes.name}`);
      }
      // 2. Admin edits (name / role / email).
      if (adminChanged) {
        const res = await superUpdateAdminApi(adminUserId, buildPayload());
        const bits: string[] = [];
        if (res.emailChanged) bits.push(res.reinvited ? `re-invited ${res.email}` : `email → ${res.email}`);
        if (res.sessionsSwept && !res.reinvited) bits.push("signed out");
        summaryBits.push(`admin ${res.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
      }
      onSuccess(summaryBits.length ? `Updated ${summaryBits.join(" · ")}` : "Saved.");
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.status === 401 && /fresh totp/i.test(err.apiError.message)) {
          // Stale MFA — switch to step-up; preserve all entered values.
          setModalState("mfa");
          return;
        }
        const code = err.apiError.details?.code as string | undefined;
        if (code === "USER_EMAIL_EXISTS") {
          setFieldErrors((e) => ({ ...e, email: "That email is already used in this company." }));
        } else if (code === "INVALID_EMAIL") {
          setFieldErrors((e) => ({ ...e, email: "Enter a valid email address." }));
        } else if (code === "LAST_ADMIN") {
          setGlobalError("This is the company's last active admin — add another admin before demoting this one.");
        } else if (code === "EMAIL_IDENTITY_CONFIRM_REQUIRED") {
          setGlobalError("Tick the identity-change confirmation to change an active admin's email.");
        } else if (code === "NO_CHANGES") {
          setGlobalError("No changes to save.");
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

  const submit = async (): Promise<void> => {
    if (!validateClient()) return;
    if (!hasChanges) {
      setGlobalError("No changes to save.");
      return;
    }
    await doSubmit();
  };

  const handleMfaVerified = (): void => {
    setModalState("form");
    void doSubmit();
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
      <Card padding="lg" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
          <h2 className="aiq-serif" style={{ fontSize: 22, margin: 0, fontWeight: 400, letterSpacing: "-0.015em" }}>
            {modalState === "mfa" ? "Verify MFA" : "Edit company"}
          </h2>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close">
            ×
          </Button>
        </div>

        {modalState === "mfa" ? (
          <MfaStepUp
            prompt="Your admin MFA needs to be verified before editing this company. Enter your 6-digit authenticator code to continue."
            onVerified={handleMfaVerified}
            onCancel={onCancel}
          />
        ) : (
          <div data-help-id="admin.platform.edit_admin">
            <p style={{ fontSize: 13, color: "var(--aiq-color-fg-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>
              Rename the company and update its primary admin. Editing the admin email changes their login identity.
            </p>
            <div style={{ ...META_LABEL, fontSize: 10, marginBottom: 16 }}>
              {tenant.slug} · {tenant.admin_status ?? "pending"}
            </div>

            {globalError && (
              <div style={{ marginBottom: 16 }}>
                <Chip>{globalError}</Chip>
              </div>
            )}

            <div style={{ display: "grid", gap: 16 }}>
              {/* Company / Organisation name (tenants.name) */}
              <div data-help-id="admin.platform.edit_company_name">
                <Field
                  label="Organisation name"
                  placeholder="Acme Corp"
                  value={orgName}
                  onChange={(e) => {
                    setOrgName(e.target.value);
                    setFieldErrors((fe) => ({ ...fe, orgName: undefined }));
                  }}
                  {...(fieldErrors.orgName ? { error: fieldErrors.orgName } : {})}
                />
                <span style={{ ...META_LABEL, display: "block", marginTop: 4, fontSize: 10, textTransform: "none", letterSpacing: 0 }}>
                  Slug &ldquo;{tenant.slug}&rdquo; is permanent and can&rsquo;t be changed.
                </span>
              </div>

              {/* ── Primary admin ── */}
              <div style={{ ...META_LABEL, fontSize: 10, marginTop: 4 }}>Primary admin</div>

              {/* Name */}
              <div data-help-id="admin.platform.admin_name">
                <Field
                  label="Admin name"
                  placeholder="Jane Smith"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setFieldErrors((fe) => ({ ...fe, name: undefined }));
                  }}
                  {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
                />
              </div>

              {/* Email */}
              <div data-help-id="admin.platform.edit_admin.email">
                <Field
                  label="Email"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setConfirmIdentity(false);
                    setFieldErrors((fe) => ({ ...fe, email: undefined }));
                  }}
                  {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
                />
                {/* Accepted admin + email change → identity-transfer warning + required confirm */}
                {needsIdentityConfirm && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "12px 14px",
                      background: "var(--aiq-color-bg-sunken)",
                      border: "1px solid var(--aiq-color-warning, #d97706)",
                      borderRadius: "var(--aiq-radius-md)",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--aiq-color-fg-secondary)" }}>
                      <strong>This changes the login identity.</strong> {origName || "This admin"} will be
                      signed out and can only sign back in with a Google account at{" "}
                      <strong>{email.trim()}</strong>. If they don't control that address, they'll be locked out.
                    </p>
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, cursor: "pointer", color: "var(--aiq-color-fg-primary)" }}>
                      <input
                        type="checkbox"
                        checked={confirmIdentity}
                        onChange={(e) => setConfirmIdentity(e.target.checked)}
                        style={{ marginTop: 2, cursor: "pointer" }}
                      />
                      <span>I understand this transfers the account's login identity.</span>
                    </label>
                  </div>
                )}
                {/* Pending admin + email change → mild re-address note */}
                {!hasAccount && emailChanged && (
                  <span style={{ ...META_LABEL, display: "block", marginTop: 6, fontSize: 10, textTransform: "none", letterSpacing: 0 }}>
                    A fresh invite goes to the new address; the old link stops working.
                  </span>
                )}
              </div>

              {/* Reason (optional, audit-logged) */}
              <div>
                <label
                  style={{ display: "block", fontFamily: "var(--aiq-font-sans)", fontSize: 12, fontWeight: 500, marginBottom: 6 }}
                >
                  Reason (optional)
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="Recorded in the audit log…"
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
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} loading={loading} disabled={!hasChanges || identityBlocked}>
                Save changes
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
