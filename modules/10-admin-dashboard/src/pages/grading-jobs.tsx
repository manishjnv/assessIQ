// AssessIQ — Admin grading jobs page.
//
// /admin/grading-jobs
//
// User-facing: plain-language explanation of how grading works today.
// Rewritten 2026-05-04: removed internal project jargon (Phase 1/3, BullMQ,
// P2.D3) and replaced with answers to "what does this mean for me right now?"
//
// Technical context (for engineers, not users):
//   - No background grading jobs in Phase 2 mode.
//   - Manual admin-click only (P2.D3: no BullMQ processors for AI grading).
//   - Card 4 ("Coming soon") will become a live job table when async grading
//     ships (Phase 3+).
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

export function AdminGradingJobs(): React.ReactElement {
  const navigate = useNavigate();

  return (
    <AdminShell breadcrumbs={["Grading"]} helpPage="admin.grading.jobs">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Page header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          <h1 style={SERIF_H1}>Grading.</h1>
          <p style={MUTED_SM}>How AI grading works in your tenant.</p>
        </div>

        {/* Card 1 — How grading works */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="sparkle" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>How grading works</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Each candidate's submitted answers are graded by AI when you start it.</li>
              <li>
                To grade a candidate's attempt: go to{" "}
                <button
                  type="button"
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  style={{ display: "inline", padding: "0 2px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)" }}
                  onClick={() => navigate("/admin/attempts")}
                >
                  <strong>Attempts</strong>
                </button>
                , click an attempt marked <strong>Submitted</strong>, then click <strong>Grade all</strong>.
              </li>
              <li>Grading takes about 30–60 seconds. You'll wait on the page while it runs.</li>
              <li>For each subjective answer (long answer, code), the AI assigns a score band — 0, 25, 50, 75, or 100 — and explains why.</li>
              <li>Auto-graded questions (multiple choice, KQL pattern) are scored immediately on submit. You don't need to trigger anything for those.</li>
            </ul>
          </div>
        </Card>

        {/* Card 2 — Reviewing AI grades */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="eye" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>Reviewing AI grades</h2>
            </div>
            <p style={BODY}>After grading completes, open the attempt detail page. For each AI-graded answer, you can:</p>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li><strong>Accept</strong> — the AI's grade stands.</li>
              <li><strong>Override grade</strong> — you record a different grade. The AI's original grade is kept beside yours and is never erased, so there's a full audit trail.</li>
            </ul>
            <p style={BODY_SM}>Add reasoning in the comment field when you override.</p>
          </div>
        </Card>

        {/* Card 3 — If grading fails */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="flag" size={18} color="var(--aiq-color-fg-muted)" />
              <h2 style={SERIF_H2}>If grading fails</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Sometimes grading runs into an error (rare, but possible).</li>
              <li>If it fails, you'll see an error on the attempt page. Click <strong>Grade all</strong> again to retry.</li>
              <li>Grading does not retry automatically — it only runs when you click.</li>
            </ul>
          </div>
        </Card>

        {/* Card 4 — Coming soon */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="clock" size={18} color="var(--aiq-color-fg-muted)" />
              <h2 style={{ ...SERIF_H2, color: "var(--aiq-color-fg-muted)" }}>Coming soon</h2>
              <Chip variant="default">Coming soon</Chip>
            </div>
            <p style={BODY}>
              A list of running, queued, and recently failed grading jobs will appear here when AssessIQ moves to background grading.
            </p>
            <p style={MUTED_SM}>
              Until then, this page is informational. All grading happens on the attempt detail page itself.
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
          {" "}for the full end-to-end assessment flow.
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
              <strong>Phase 2 mode — sync grading.</strong> No background grading jobs exist.
              Grading is triggered manually via POST /admin/attempts/:id/grade and runs
              synchronously on admin click (P2.D3: no BullMQ processors for AI).
            </p>
            <p style={{ margin: 0, lineHeight: 1.6 }}>
              Background async grading (BullMQ) is deferred to Phase 3. This page will show
              running, queued, and failed job rows when that feature ships.
            </p>
          </div>
        </details>

      </div>
    </AdminShell>
  );
}
