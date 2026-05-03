// AssessIQ — Admin billing settings page.
//
// /admin/settings/billing
//
// Phase 2 stub — grading uses the admin's Max OAuth session and Claude Code
// runtime. There is no metered billing or per-token cost tracking in Phase 1/2.
// Billing management is deferred to Phase 3.

import React from "react";
import { AdminShell } from "../components/AdminShell.js";

export function AdminBilling(): React.ReactElement {
  return (
    <AdminShell breadcrumbs={["Settings", "Billing"]} helpPage="admin.settings.billing">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
          Billing &amp; budgets.
        </h1>

        <div className="aiq-card" style={{ padding: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
          <span
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--aiq-color-fg-muted)",
              background: "var(--aiq-color-bg-sunken)",
              padding: "2px 10px",
              borderRadius: "var(--aiq-radius-pill)",
              alignSelf: "flex-start",
            }}
          >
            Phase 2 — Max OAuth mode
          </span>

          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", lineHeight: 1.6, color: "var(--aiq-color-fg-secondary)" }}>
            Phase 2 grading uses the admin's Claude Max OAuth session running
            via the Claude Code VPS runtime. API usage is bound to the admin's
            own Max subscription — there is no per-tenant billing or token
            metering at this stage.
          </p>

          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            Per-tenant usage budgets and Anthropic API key management are planned
            for Phase 3. When that ships, this page will show monthly token usage,
            cost estimates, alert thresholds, and budget caps per assessment cycle.
          </p>
        </div>

        <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
            Grading budget guard
          </h2>
          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", lineHeight: 1.6, color: "var(--aiq-color-fg-secondary)" }}>
            A <code style={{ fontFamily: "var(--aiq-font-mono)", background: "var(--aiq-color-bg-sunken)", padding: "1px 4px", borderRadius: 3 }}>tenant_grading_budgets</code> row
            is created for each tenant on first grading run. The budget guard
            (P2.D6) hard-blocks grading when the monthly cap is exceeded.
            Default cap: 100 grading runs / month (configurable by platform admin
            in the database directly until Phase 3 UI ships).
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
