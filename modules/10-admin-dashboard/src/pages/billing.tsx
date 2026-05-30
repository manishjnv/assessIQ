// AssessIQ — Admin billing settings page.
//
// /admin/settings/billing
//
// User-facing: plain-language explanation of AI grading costs and monthly limits.
// Rewritten 2026-05-04: removed internal project jargon (Phase 2/3, Max OAuth,
// P2.D6, tenant_grading_budgets, "platform admin updates the database directly")
// and replaced with answers to "what does this mean for me right now?"
//
// 2026-05-10: Added super-admin-only AI Generation Mode card (Stage 3 rollout).
// Rendered only when session.user.role === 'super_admin'. Tenant admins see
// nothing — no greyed-out control, no tooltip mentioning the option.
//
// Technical context (for engineers, not users):
//   - Phase 2 grading uses the admin's Claude Max OAuth session via VPS runtime.
//   - No per-tenant billing or token metering at this stage.
//   - Budget guard (P2.D6): tenant_grading_budgets row hard-blocks at 100 runs/month.
//   - Limit changes require platform admin to update the database directly until
//     a Phase 3 management UI ships.
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
          <h1 style={SERIF_H1}>Billing &amp; limits.</h1>
          <p style={MUTED_SM}>How AI grading is paid for, and how many you can run each month.</p>
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
                  data-help-id="admin.settings.ai_generate_mode"
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

        {/* Card 1 — How AI grading is paid for today */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="sparkle" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>How AI grading is paid for today</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Right now, AI grading runs on the AssessIQ platform's own AI account, not yours.</li>
              <li>You are <strong>not charged per grading run today.</strong></li>
              <li>
                This will change when AssessIQ adds direct AI billing per tenant.
                When that happens, this page will show your monthly usage, cost estimates, and customisable limits.
              </li>
            </ul>
            <p style={MUTED_SM}>
              <Chip variant="default">Coming soon</Chip>
              {" "}Per-tenant billing and usage dashboards are not available yet.
            </p>
          </div>
        </Card>

        {/* Card 2 — Your monthly grading limit */}
        <Card>
          <div
            data-help-id="admin.settings.billing.budget"
            style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="chart" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>Your monthly grading limit</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Your tenant can run up to <strong>100 grading runs per month</strong> by default.</li>
              <li>A "grading run" = one click of the <strong>Grade all</strong> button on an attempt.</li>
              <li>
                Once you reach 100 in a calendar month, the <strong>Grade all</strong> button will return an error
                until next month, or until your AssessIQ administrator raises your limit.
              </li>
              <li>
                To check your current usage or request a higher limit, contact your AssessIQ administrator
                (the email address on your contract or onboarding documents).
              </li>
            </ul>
          </div>
        </Card>

        {/* Card 3 — Why a limit? */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="bell" size={18} color="var(--aiq-color-fg-muted)" />
              <h2 style={{ ...SERIF_H2, color: "var(--aiq-color-fg-secondary)" }}>Why a limit?</h2>
            </div>
            <p style={BODY}>
              Limits protect both you and AssessIQ from runaway grading costs and prevent accidental over-use.
            </p>
            <p style={BODY_SM}>
              Most tenants find 100 runs per month is plenty. If you regularly run large cohort assessments
              and need a higher limit, just ask your AssessIQ administrator.
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
          {" "}for how grading fits into the full assessment flow.
        </p>

        {/* Technical details — for engineers / audit purposes */}
        <details style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          <summary style={{ cursor: "pointer", userSelect: "none", padding: "var(--aiq-space-sm) 0" }}>
            Technical details (for engineers)
          </summary>
          <div
            className="aiq-card"
            style={{ marginTop: "var(--aiq-space-sm)", padding: "var(--aiq-space-lg)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", background: "var(--aiq-color-bg-sunken)" }}
          >
            <p style={{ margin: 0, lineHeight: 1.6 }}>
              <strong>Phase 2 — Max OAuth mode.</strong> Grading uses the admin's Claude Max OAuth session
              running via the Claude Code VPS runtime. API usage is bound to the admin's own Max subscription.
              No per-tenant billing or token metering at this stage.
            </p>
            <p style={{ margin: 0, lineHeight: 1.6 }}>
              Budget guard (P2.D6): a <code style={{ fontFamily: "var(--aiq-font-mono)", background: "var(--aiq-color-bg-sunken)", padding: "1px 4px", borderRadius: 3 }}>tenant_grading_budgets</code> row
              is created on first grading run. Hard-blocks at 100 runs / month by default.
              Configurable by platform admin in the database directly until a Phase 3 management UI ships.
            </p>
            <p style={{ margin: 0, lineHeight: 1.6 }}>
              Per-tenant usage budgets and Anthropic API key management are planned for Phase 3. When that
              ships, this page will show monthly token usage, cost estimates, alert thresholds, and budget
              caps per assessment cycle.
            </p>
          </div>
        </details>

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
