// AssessIQ — Admin grading jobs page.
//
// /admin/grading-jobs
//
// User-facing: plain-language explanation of how grading works today.
// Rewritten 2026-05-04: removed internal project jargon (Phase 1/3, BullMQ,
// P2.D3) and replaced with answers to "what does this mean for me right now?"
// Rewritten 2026-10-01 (scoring/release change): AssessIQ evaluates written
// answers from the super-admin queue; the company only reviews and publishes.
//
// Technical context (for engineers, not users):
//   - No background grading jobs in Phase 2 mode.
//   - AI evaluation runs only on a super-admin click (P2.D3: no BullMQ
//     processors for AI grading); tenant routes return 403
//     AI_EVALUATION_BY_ASSESSIQ.
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
          <p style={MUTED_SM}>How results get scored, and what you do with them.</p>
        </div>

        {/* Card 1 — How grading works */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="sparkle" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>How grading works</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Multiple-choice answers are scored automatically the moment a candidate submits. You don't need to trigger anything for those.</li>
              <li>
                Written answers (long answers, scenarios, log analysis) are evaluated by AssessIQ evaluators with AI assistance. You don't grade them yourself.
              </li>
              <li>
                Until that evaluation is done the attempt shows <strong>Awaiting evaluation</strong> and no score is visible, to you or to the candidate.
              </li>
              <li>
                When it is done the attempt shows <strong>Ready to publish</strong>. Open it on{" "}
                <button
                  type="button"
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  style={{ display: "inline", padding: "0 2px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)" }}
                  onClick={() => navigate("/admin/attempts")}
                >
                  <strong>Attempts</strong>
                </button>{" "}
                to review the final scores.
              </li>
              <li>For each written answer the evaluation assigns a score band — 0, 25, 50, 75, or 100 — with the evidence and reasoning behind it.</li>
            </ul>
          </div>
        </Card>

        {/* Card 2 — Reviewing AI grades */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="eye" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>Reviewing and publishing</h2>
            </div>
            <p style={BODY}>Open an attempt marked Ready to publish. You can:</p>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li><strong>Publish to candidate</strong> — the candidate sees the result. Use <strong>Publish all ready</strong> on the assessment page to publish many at once, or choose Automatic release in Settings.</li>
              <li><strong>Override grade</strong> — you record a different grade. The original grade is kept beside yours and is never erased, so there's a full audit trail.</li>
              <li><strong>Send back for re-evaluation</strong> — returns the attempt to AssessIQ with a note.</li>
            </ul>
            <p style={BODY_SM}>Add a reason when you override. Published results can't be changed.</p>
          </div>
        </Card>

        {/* Card 3 — If grading fails */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="flag" size={18} color="var(--aiq-color-fg-muted)" />
              <h2 style={SERIF_H2}>If something looks wrong</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Nothing is shown to candidates until the result is complete, so a slow evaluation never exposes a partial score.</li>
              <li>If an attempt stays on <strong>Awaiting evaluation</strong> longer than the turnaround you were given, contact your AssessIQ operator.</li>
              <li>If a score that is ready to publish looks wrong, override it with a reason or send the attempt back.</li>
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
              Until then, this page is informational. Evaluation happens in AssessIQ's own queue; you review the result on the attempt page.
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
              Grading is triggered manually via POST /admin/super/evaluations/:id/grade and
              runs synchronously on a super-admin click (P2.D3: no BullMQ processors for AI).
              Tenant admins cannot run AI grading — their routes return 403 AI_EVALUATION_BY_ASSESSIQ.
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
