// AssessIQ — Admin "Evaluation status" page (was the static "Grading" explainer).
//
// /admin/grading-jobs  (apps/web/src/App.tsx, role="admin"; the route path is
// unchanged so links and the e2e spec keep working)
//
// FU-C1 (2026-10-06): read-only status of the evaluation queue for this company:
//   - counts from GET /api/admin/dashboard/queue (`counts`, same source as the
//     dashboard KPI cards; `countGradingQueue` in 07)
//   - age of the oldest attempt still waiting (`oldest_waiting_submitted_at`)
//   - one row per assessment with the three counts (`by_assessment`)
//   - the explainer text, condensed into one card
// No new AI call path: this page only reads. Nothing is started from here.
//
// Facts behind the copy: AssessIQ evaluates written answers from the
// super-admin queue in submission order; the company only reviews and
// publishes. No turnaround number is promised here because none is defined
// in the product (the help text says: contact your AssessIQ operator).
//
// Kit: page header (serif h1 + lede), stat-card row (dashboard.jsx), card
// rows with mono eyebrow (patterns.md "Section header"). Diverges from no
// kit screen.
//
// INVARIANTS:
//   - No claude/anthropic imports or user-facing references.
//   - No new @assessiq/ui-system primitives — Card, Icon, StatCard, Chip, Spinner.

import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Chip, Icon, Spinner, StatCard } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

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

const MUTED_SM: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-muted)",
  lineHeight: 1.65,
  margin: 0,
};

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

const NUM: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontVariantNumeric: "lining-nums tabular-nums",
  fontSize: "var(--aiq-text-md)",
  textAlign: "right",
};

interface QueueCountsByAssessment {
  assessment_id: string;
  assessment_name: string;
  in_queue: number;
  awaiting_evaluation: number;
  ready_to_publish: number;
}

interface QueueCounts {
  in_queue: number;
  awaiting_evaluation: number;
  ready_to_publish: number;
  oldest_waiting_submitted_at?: string | null;
  by_assessment?: QueueCountsByAssessment[];
}

/** "3 hours", "2 days" — whole units, for the oldest-waiting line. */
export function waitingAge(submittedAtIso: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - new Date(submittedAtIso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function AdminGradingJobs(): React.ReactElement {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // limit=1: only the tenant-wide `counts` are used here.
      const data = await adminApi<{ counts: QueueCounts }>("/admin/dashboard/queue?limit=1");
      setCounts(data.counts);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load the evaluation status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const rows = counts?.by_assessment ?? [];
  const oldest = counts?.oldest_waiting_submitted_at ?? null;

  return (
    <AdminShell breadcrumbs={["Evaluation status"]} helpPage="admin.grading.jobs">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Page header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          <h1 style={SERIF_H1}>Evaluation status.</h1>
          <p style={MUTED_SM}>Where the written answers of your candidates are in the evaluation queue. Nothing is started from this page.</p>
        </div>

        {error && <div><Chip>{error}</Chip></div>}

        {loading && counts === null ? (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-3xl) 0" }}>
            <Spinner aria-label="Loading evaluation status" />
          </div>
        ) : counts !== null && (
          <>
            {/* Counts — same numbers as the dashboard cards */}
            <div data-help-id="admin.grading.jobs.counts" style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
              <StatCard label="In queue" value={counts.in_queue} />
              <StatCard label="Awaiting evaluation" value={counts.awaiting_evaluation} />
              <StatCard label="Ready to publish" value={counts.ready_to_publish} />
            </div>

            {/* Oldest waiting + expected time text */}
            <Card>
              <div data-help-id="admin.grading.jobs.oldest" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-xl)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                  <Icon name="clock" size={18} color="var(--aiq-color-accent)" />
                  <h2 style={SERIF_H2}>Waiting time</h2>
                </div>
                {oldest === null ? (
                  <p style={BODY}>No attempt is waiting for evaluation.</p>
                ) : (
                  <p style={BODY}>
                    The oldest waiting attempt was submitted <strong>{waitingAge(oldest)} ago</strong>
                    {" "}({new Date(oldest).toLocaleString()}).
                  </p>
                )}
                <p style={MUTED_SM}>
                  AssessIQ evaluates written answers in submission order on the platform queue. Multiple-choice answers are scored at submit and never wait.
                  If an attempt waits longer than the turnaround you were given, contact your AssessIQ operator.
                </p>
              </div>
            </Card>

            {/* Per-assessment rows */}
            <Card>
              <div data-help-id="admin.grading.jobs.by_assessment" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
                  <Icon name="grid" size={18} color="var(--aiq-color-accent)" />
                  <h2 style={SERIF_H2}>By assessment</h2>
                  <span style={{ flex: 1 }} />
                  <Chip>{rows.length} assessment{rows.length !== 1 ? "s" : ""}</Chip>
                </div>
                {rows.length === 0 ? (
                  <p style={BODY}>No submitted attempt yet.</p>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 150px 140px", gap: "var(--aiq-space-xs) var(--aiq-space-md)", alignItems: "center" }}>
                    <span style={MONO_LABEL}>Assessment</span>
                    <span style={{ ...MONO_LABEL, textAlign: "right" }}>In queue</span>
                    <span style={{ ...MONO_LABEL, textAlign: "right" }}>Awaiting</span>
                    <span style={{ ...MONO_LABEL, textAlign: "right" }}>Ready to publish</span>
                    {rows.map((r) => (
                      <React.Fragment key={r.assessment_id}>
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                          style={{ justifyContent: "flex-start", padding: "4px 6px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}
                          onClick={() => navigate(`/admin/assessments/${r.assessment_id}`)}
                        >
                          {r.assessment_name}
                        </button>
                        <span style={NUM}>{r.in_queue}</span>
                        <span style={NUM}>{r.awaiting_evaluation}</span>
                        <span style={NUM}>{r.ready_to_publish}</span>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </>
        )}

        {/* How it works — the former explainer, condensed */}
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-xl)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <Icon name="sparkle" size={18} color="var(--aiq-color-accent)" />
              <h2 style={SERIF_H2}>How evaluation works</h2>
            </div>
            <ul style={{ ...BODY, paddingLeft: "var(--aiq-space-xl)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              <li>Multiple-choice answers are scored the moment a candidate submits.</li>
              <li>Written answers are evaluated by AssessIQ. Until then the attempt shows <strong>Awaiting evaluation</strong> and no score is visible to you or the candidate.</li>
              <li>Each written answer gets a score band of 0, 25, 50, 75 or 100 with the evidence behind it.</li>
              <li>
                When the evaluation is done the attempt shows <strong>Ready to publish</strong>. Open it on{" "}
                <button
                  type="button"
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  style={{ display: "inline", padding: "0 2px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)" }}
                  onClick={() => navigate("/admin/attempts")}
                >
                  <strong>Attempts</strong>
                </button>{" "}
                to publish it, override a grade with a reason, or send it back for re-evaluation. Published results cannot be changed.
              </li>
            </ul>
          </div>
        </Card>

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
      </div>
    </AdminShell>
  );
}
