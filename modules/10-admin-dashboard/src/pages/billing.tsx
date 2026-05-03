// AssessIQ — Admin billing settings page.
//
// /admin/settings/billing
//
// User-facing: plain-language explanation of AI grading costs and monthly limits.
// Rewritten 2026-05-04: removed internal project jargon (Phase 2/3, Max OAuth,
// P2.D6, tenant_grading_budgets, "platform admin updates the database directly")
// and replaced with answers to "what does this mean for me right now?"
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

import React from "react";
import { useNavigate } from "react-router-dom";
import { Card, Chip, Icon } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";

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

  return (
    <AdminShell breadcrumbs={["Settings", "Billing"]} helpPage="admin.settings.billing">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Page header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          <h1 style={SERIF_H1}>Billing &amp; limits.</h1>
          <p style={MUTED_SM}>How AI grading is paid for, and how many you can run each month.</p>
        </div>

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
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
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

      </div>
    </AdminShell>
  );
}
