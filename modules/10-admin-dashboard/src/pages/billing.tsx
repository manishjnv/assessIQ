// AssessIQ — Admin "Plan & usage" settings page.
//
// Routes (apps/web/src/App.tsx, role="admin"; super_admin also passes):
//   /admin/settings                 — renders this page
//   /admin/settings/billing         — back-compat redirect to /admin/settings
//
// What the page shows, top to bottom:
//   1. Super-admin-only "AI Generation Mode" card (omnibus / sharded, per
//      tenant, audit-logged). Rendered only when session.user.role ===
//      'super_admin'. Tenant admins see nothing — no greyed-out control, no
//      tooltip mentioning the option.
//   2. "Your plan & usage" card (all admins): plan tier, credits used,
//      included, remaining, overage, and a status chip. Data comes from
//      getCompanyUsage(); the card stays hidden if that call fails.
//   3. Static "How evaluation and usage work" and "Questions about your plan"
//      cards, plus a link to the Help guide.
//   4. The embedded <TenantSettings embedded /> block (DPDP data retention and
//      other tenant-level controls). /admin/tenant-settings stays as an alias
//      for direct URL access.
//
// History: 2026-05-04 rewritten in plain language (no internal project
// jargon). 2026-05-10 added the super-admin AI Generation Mode card.
//
// INVARIANTS:
//   - No claude/anthropic imports or user-facing references.
//   - No new @assessiq/ui-system primitives — uses existing Card, Chip, Icon.

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Chip, Icon } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { HelpTip } from "@assessiq/help-system/components";
import { useAdminSession } from "../session.js";
import { updateTenantAiGenerateMode, getCompanyUsage, type AiGenerateMode, type CompanyUsage } from "../api.js";
import { usageMessage } from "../components/UsageBanner.js";
import { TenantSettings } from "./tenant-settings.js";

// ── Shared style objects ──────────────────────────────────────────────────────

const SERIF_H1: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontSize: "var(--aiq-text-3xl)",
  fontWeight: 400,
  margin: 0,
  letterSpacing: "-0.02em",
  color: "var(--aiq-color-fg-primary)",
};

const SERIF_H2: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontSize: "var(--aiq-text-xl)",
  fontWeight: 400,
  margin: 0,
  letterSpacing: "-0.015em",
  color: "var(--aiq-color-fg-primary)",
};

const BODY: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-md)",
  color: "var(--aiq-color-fg-secondary)",
  lineHeight: 1.65,
  margin: 0,
};

const BODY_SM: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-secondary)",
  lineHeight: 1.65,
  margin: 0,
};

const MUTED_SM: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-muted)",
  lineHeight: 1.65,
  margin: 0,
};

export function AdminBilling(): React.ReactElement {
  const navigate = useNavigate();
  const { session } = useAdminSession();
  const isSuperAdmin = session?.user.role === "super_admin";

  // Super-admin AI mode state. Only populated / rendered when isSuperAdmin.
  // tenantId of the CURRENT session's tenant is used as the target when the
  // super-admin is viewing "their own" management tenant. In a multi-tenant
  // management flow, this would come from a route param.
  const tenantId = session?.tenant.id ?? "";
  const [selectedMode, setSelectedMode] = useState<AiGenerateMode>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastAuditId, setLastAuditId] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  // A2 — "Your plan & usage" card state (all admins)
  const [companyUsage, setCompanyUsage] = useState<CompanyUsage | null>(null);

  useEffect(() => {
    void getCompanyUsage()
      .then(setCompanyUsage)
      .catch(() => {
        // Fail-silent — card just stays hidden
      });
  }, []);

  return (
    <AdminShell breadcrumbs={["Settings"]} helpPage="admin.settings.billing">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Page header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          <h1 style={SERIF_H1}>Plan &amp; usage.</h1>
          <p style={MUTED_SM}>Your plan tier and credit usage.</p>
        </div>

        {/* Super-admin only: AI Generation Mode card.
            Tenant admins never see this section — not even greyed out. */}
        {isSuperAdmin && (
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                <Icon name="sparkle" size={18} color="var(--aiq-color-warning, #d97706)" />
                <h2 style={SERIF_H2}>AI Generation Mode</h2>
                <Chip variant="default" style={{ marginLeft: "var(--aiq-space-sm)" }}>Super-admin only</Chip>
              </div>

              <p style={{ ...BODY_SM, color: "var(--aiq-color-fg-muted)", display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
                ⚠️ Changes are audit-logged and take effect on the next generation request.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                <label
                  htmlFor="ai-generate-mode-select"
                  data-help-id="admin.settings.billing.ai_generate_mode"
                  style={{ ...BODY_SM, fontWeight: 500 }}
                >
                  Mode
                </label>
                <select
                  id="ai-generate-mode-select"
                  value={selectedMode ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSelectedMode(v === "" ? null : (v as AiGenerateMode));
                    setSaveError(null);
                  }}
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                    borderRadius: "var(--aiq-radius-md)",
                    border: "1px solid var(--aiq-color-border)",
                    background: "var(--aiq-color-bg-raised)",
                    color: "var(--aiq-color-fg-primary)",
                    width: 260,
                    cursor: "pointer",
                  }}
                >
                  <option value="">Use global default (omnibus)</option>
                  <option value="omnibus">omnibus</option>
                  <option value="sharded">sharded</option>
                </select>
                <p style={MUTED_SM}>
                  Current global default: <strong>omnibus</strong> (from AI_GENERATE_MODE env var).
                </p>
              </div>

              {saveError !== null && (
                <p style={{ ...BODY_SM, color: "var(--aiq-color-danger)" }}>{saveError}</p>
              )}

              {toastVisible && lastAuditId !== null && (
                <p style={{ ...BODY_SM, color: "var(--aiq-color-success)" }}>
                  AI mode updated. Audit log entry: {lastAuditId}
                </p>
              )}

              {/* Confirmation dialog (inline, not a modal — matches existing admin UI pattern) */}
              {confirmPending ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-sm)",
                    padding: "var(--aiq-space-md)",
                    background: "var(--aiq-color-bg-sunken)",
                    borderRadius: "var(--aiq-radius-md)",
                    border: "1px solid var(--aiq-color-warning, #d97706)",
                  }}
                >
                  <p style={{ ...BODY_SM, margin: 0 }}>
                    Switch this tenant to{" "}
                    <strong>{selectedMode === null ? "global default" : selectedMode}</strong>?
                    This change is audit-logged and takes effect on the next generation request.
                  </p>
                  <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                    <button
                      type="button"
                      className="aiq-btn aiq-btn-primary aiq-btn-sm"
                      disabled={saving}
                      onClick={async () => {
                        setSaving(true);
                        setSaveError(null);
                        try {
                          const res = await updateTenantAiGenerateMode(tenantId, selectedMode);
                          setLastAuditId(res.auditId);
                          setToastVisible(true);
                          setConfirmPending(false);
                          setTimeout(() => setToastVisible(false), 8_000);
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : "Save failed";
                          setSaveError(msg);
                          setConfirmPending(false);
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {saving ? "Saving…" : "Confirm"}
                    </button>
                    <button
                      type="button"
                      className="aiq-btn aiq-btn-outline aiq-btn-sm"
                      disabled={saving}
                      onClick={() => setConfirmPending(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-primary aiq-btn-sm"
                    onClick={() => setConfirmPending(true)}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* A2 — "Your plan & usage" card (all admins; rendered when usage data is available) */}
        {companyUsage !== null && (() => {
          const msg = usageMessage(companyUsage);
          const statusColor =
            companyUsage.status === "over"
              ? "var(--aiq-color-danger, #dc2626)"
              : companyUsage.status === "warn"
                ? "var(--aiq-color-warning, #d97706)"
                : "var(--aiq-color-success, #16a34a)";
          const statusLabel =
            companyUsage.status === "unlimited"
              ? "Unlimited"
              : companyUsage.status === "ok"
                ? "On track"
                : companyUsage.status === "warn"
                  ? "Near limit"
                  : "Over limit";
          return (
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                  <Icon name="chart" size={18} color="var(--aiq-color-accent)" />
                  {/* Help key renamed to the page-prefix-matching id so the
                      drawer resolves: billing page helpPage="admin.settings.billing"
                      loads keys LIKE 'admin.settings.billing.%'. */}
                  <HelpTip helpId="admin.settings.billing.usage">
                    <h2 style={SERIF_H2}>Your plan &amp; usage</h2>
                  </HelpTip>
                  <Chip
                    variant={companyUsage.status === "over" ? "warn" : companyUsage.status === "warn" ? "default" : "success"}
                    style={{ marginLeft: "var(--aiq-space-sm)" }}
                  >
                    {statusLabel}
                  </Chip>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                    gap: "var(--aiq-space-md)",
                  }}
                >
                  <div>
                    <p style={MUTED_SM}>Plan tier</p>
                    <p style={{ ...BODY_SM, fontWeight: 600, textTransform: "capitalize" }}>
                      {companyUsage.tier}
                    </p>
                  </div>
                  <div>
                    <p style={MUTED_SM}>Credits used</p>
                    <p style={{ ...BODY_SM, fontWeight: 600 }}>{companyUsage.used}</p>
                  </div>
                  <div>
                    <p style={MUTED_SM}>Included</p>
                    <p style={{ ...BODY_SM, fontWeight: 600 }}>
                      {companyUsage.included_credits !== null
                        ? companyUsage.included_credits
                        : "Unlimited"}
                    </p>
                  </div>
                  <div>
                    <p style={MUTED_SM}>Remaining</p>
                    <p style={{ ...BODY_SM, fontWeight: 600 }}>
                      {companyUsage.remaining !== null
                        ? companyUsage.remaining
                        : "Unlimited"}
                    </p>
                  </div>
                  {companyUsage.overage > 0 && (
                    <div>
                      <p style={MUTED_SM}>Overage</p>
                      <p style={{ ...BODY_SM, fontWeight: 600, color: statusColor }}>
                        +{companyUsage.overage}
                      </p>
                    </div>
                  )}
                </div>

                {msg !== null && (
                  <p style={{ ...BODY_SM, color: statusColor, margin: 0 }}>{msg.text}</p>
                )}
              </div>
            </Card>
          );
        })()}

        {/* Card 1 — How evaluation and usage work */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="sparkle" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>How evaluation and usage work</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>AssessIQ evaluates written answers. You do not start evaluation yourself.</li>
              <li>Questions with a fixed answer are scored automatically when a candidate submits.</li>
              <li>Usage is counted in credits under your plan tier. See <strong>Your plan &amp; usage</strong> above.</li>
              <li>No limit blocks you from inviting candidates or publishing results.</li>
            </ul>
          </div>
        </Card>

        {/* Card 2 — Plan questions (keeps the data-help-id container) */}
        <Card>
          <div
            data-help-id="admin.settings.billing.budget"
            style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="chart" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>Questions about your plan</h2>
            </div>
            <p style={BODY}>
              To check your plan tier or discuss changes, contact your AssessIQ administrator. Use the email address in your onboarding documents.
            </p>
          </div>
        </Card>

        {/* Footer */}
        <p style={MUTED_SM}>
          See the{" "}
          <button
            type="button"
            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
            style={{ display: "inline", padding: "0 2px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-accent)" }}
            onClick={() => navigate("/admin/guide")}
          >
            Help guide
          </button>
          {" "}for how evaluation fits into the full assessment flow.
        </p>

        {/* ── DPDP Data Retention (embedded from tenant-settings.tsx) ──────
            Merged into the Settings page to keep the admin nav minimal —
            tenant-level controls live under one Settings entry. The
            standalone /admin/tenant-settings route is retained as an
            alias for direct URL access. */}
        <TenantSettings embedded />

      </div>
    </AdminShell>
  );
}
