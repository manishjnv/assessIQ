// AssessIQ — Admin grading jobs page.
//
// /admin/grading-jobs
//
// Phase 2 stub — there are no background grading jobs in Phase 1 mode.
// Manual admin-click only (P2.D3: no BullMQ processors for AI grading).
//
// This page will be live in Phase 3 when async grading is introduced.

import React from "react";
import { AdminShell } from "../components/AdminShell.js";

export function AdminGradingJobs(): React.ReactElement {
  return (
    <AdminShell breadcrumbs={["Grading Jobs"]} helpPage="admin.grading.jobs">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
          Grading jobs.
        </h1>

        <div
          className="aiq-card"
          style={{
            padding: "var(--aiq-space-xl)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--aiq-space-md)",
            alignItems: "flex-start",
          }}
        >
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
            }}
          >
            Phase 1 mode — sync grading
          </span>
          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.6 }}>
            No background grading jobs in this deployment mode. Phase 1 grading
            is triggered manually on the attempt detail page and runs synchronously
            on admin click.
          </p>
          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            Background async grading (BullMQ) is deferred to Phase 3. This page
            will show running, queued, and failed job rows when that feature ships.
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
