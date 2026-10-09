// AssessIQ — Admin attempt detail page (tenant review).
//
// /admin/attempts/:id
//
// Scoring/release change (spec 2026-10-01, SP9/SP10): AssessIQ evaluates written
// answers (super-admin evaluation queue); the company only reviews and publishes.
// This page therefore has NO Grade all / Accept all / Re-run / manual score. It
// follows `evaluation_status` from GET /admin/attempts/:id:
//
//   awaiting_evaluation  banner only — AssessIQ has not released the evaluation
//   ready_to_publish     final grades + Override (reason), "Send back for
//                        re-evaluation" (note) and "Release to candidate"
//   published            read-only
//
// GET /admin/attempts/:id has no side effects (it no longer claims the attempt).
//
// Layout: header + banners, then the shared <AttemptGradingPanel mode="review">
// (four-zone audit card per question).
//
// Actions:
//  - Override: POST /admin/gradings/:id/override (fresh-MFA; inline step-up)
//  - Send back: POST /admin/attempts/:id/send-back { note }
//  - Publish:  POST /admin/attempts/:id/release (terminal)
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - ai_justification + candidate answer displayed as plain text only.

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Chip, Spinner, ErasedChip, formatDateTime } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { AttemptGradingPanel } from "../components/AttemptGradingPanel.js";
import { ReleaseConfirmModal } from "../components/ReleaseConfirmModal.js";
import { AttemptIntegrityCard } from "../components/AttemptIntegrityCard.js";
import { adminApi } from "../api.js";
import {
  apiMessage,
  evaluationMeta,
  evaluationStatusOf,
  normaliseDetail,
} from "../lib/evaluation.js";
import type { AttemptDetailResponse } from "../lib/evaluation.js";
import { evaluationStatusDisplay } from "../lib/status.js";

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};


export function AdminAttemptDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<AttemptDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Publish: summary modal so the admin sees the full evaluation BEFORE it goes
  // to the candidate (replaces window.confirm).
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releasing, setReleasing] = useState(false);

  // Send back for re-grading: inline note form.
  const [showSendBack, setShowSendBack] = useState(false);
  const [sendBackNote, setSendBackNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);

  // `silent` reloads keep the current page on screen (the grading panel holds
  // open forms), only the first load shows the spinner.
  const fetchDetail = useCallback(
    async (silent: boolean): Promise<void> => {
      if (!id) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        setDetail(normaliseDetail(await adminApi<AttemptDetailResponse>(`/admin/attempts/${id}`)));
      } catch (err) {
        setError(apiMessage(err, "Failed to load attempt."));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id],
  );
  const reload = useCallback(() => fetchDetail(true), [fetchDetail]);

  useEffect(() => {
    void fetchDetail(false);
  }, [fetchDetail]);

  async function handlePublish(): Promise<void> {
    if (!id) return;
    setReleasing(true);
    try {
      await adminApi(`/admin/attempts/${id}/release`, { method: "POST" });
      setShowReleaseModal(false);
      await reload();
    } catch (err) {
      // Close the summary so the error banner behind it is visible.
      setShowReleaseModal(false);
      setError(apiMessage(err, "Release failed."));
    } finally {
      setReleasing(false);
    }
  }

  async function handleSendBack(): Promise<void> {
    if (!id || !sendBackNote.trim()) return;
    setSendingBack(true);
    try {
      await adminApi(`/admin/attempts/${id}/send-back`, {
        method: "POST",
        body: JSON.stringify({ note: sendBackNote.trim() }),
      });
      setShowSendBack(false);
      setSendBackNote("");
      setError(null);
      await reload();
    } catch (err) {
      setError(apiMessage(err, "Send back failed."));
    } finally {
      setSendingBack(false);
    }
  }

  const crumbs = [{ label: "Attempts", href: "/admin/attempts" }, "Detail"];

  if (loading) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.attempts.detail">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading attempt" />
        </div>
      </AdminShell>
    );
  }

  if (!detail) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.attempts.detail">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const { attempt, frozen_questions, gradings } = detail;
  const evalStatus = evaluationStatusOf(attempt.status, evaluationMeta(detail).evaluation_status);
  const display = evaluationStatusDisplay(evalStatus);
  const candidateName = attempt.candidate_name ?? "";

  return (
    <AdminShell
      breadcrumbs={[
        { label: "Attempts", href: "/admin/attempts" },
        attempt.assessment_name || "Attempt",
        candidateName || "Candidate",
      ]}
      helpPage="admin.attempts.detail"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <div>
            <div style={{ marginBottom: 12 }}>
              <Chip variant={display.variant}>{display.label}</Chip>
            </div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              {attempt.assessment_name || "Attempt"}
            </h1>
            <div style={{ ...MONO_LABEL, marginTop: "var(--aiq-space-xs)", display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              <span>
                {[
                  candidateName,
                  attempt.level_label,
                  attempt.submitted_at ? formatDateTime(attempt.submitted_at) : null,
                ].filter(Boolean).join(" · ") || "Candidate details are not available"}
              </span>
              {attempt.isErased && <ErasedChip />}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
            {/* Print review: window.print() + the panel's @media print stylesheet. */}
            {gradings.length > 0 && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-no-print"
                data-help-id="admin.attempts.detail.print_review"
                onClick={() => window.print()}
              >
                Print review
              </button>
            )}
            {evalStatus === "ready_to_publish" && (
              <button
                type="button"
                className="aiq-btn aiq-btn-outline aiq-no-print"
                data-help-id="admin.attempts.detail.send_back"
                onClick={() => setShowSendBack(true)}
              >
                Send back for re-grading
              </button>
            )}
            {evalStatus === "ready_to_publish" && !attempt.isErased && (
              <button
                type="button"
                className="aiq-btn aiq-btn-primary aiq-no-print"
                data-help-id="admin.attempts.detail.release_button"
                onClick={() => setShowReleaseModal(true)}
              >
                Release to candidate
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="aiq-banner aiq-banner-error aiq-error-banner" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-md) var(--aiq-space-xl)", backgroundColor: "var(--aiq-color-danger-subtle, #fff0f0)", border: "1px solid var(--aiq-color-danger)", borderRadius: "var(--aiq-radius-sm, 4px)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="aiq-btn aiq-btn-sm" style={{ flexShrink: 0 }} onClick={() => { setError(null); void reload(); }}>
              Refresh
            </button>
            <button type="button" className="aiq-btn aiq-btn-sm aiq-btn-outline" style={{ flexShrink: 0 }} onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* 3-step status bar: Evaluated → Reviewed → Published */}
        <div style={{ display: "flex", gap: "var(--aiq-space-lg)", alignItems: "center", justifyContent: "flex-start", padding: "var(--aiq-space-md) 0" }}>
          {[
            { label: "Evaluated", complete: evalStatus !== "awaiting_evaluation" },
            { label: "Reviewed", complete: evalStatus === "ready_to_publish" || evalStatus === "published" },
            { label: "Published", complete: evalStatus === "published" },
          ].map((step, idx) => (
            <div key={idx} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
              <div
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: step.complete ? "var(--aiq-color-success)" : "var(--aiq-color-border)",
                  color: "white",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {step.complete ? "✓" : ""}
              </div>
              <span style={{ fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)", fontWeight: 500 }}>
                {step.label}
              </span>
            </div>
          ))}
        </div>

        {/* Awaiting AssessIQ evaluation — no grades are shown until the
            evaluation is sent to the organisation. */}
        {evalStatus === "awaiting_evaluation" && (
          <div
            className="aiq-banner"
            data-help-id="admin.attempts.detail.awaiting_evaluation"
            role="status"
            style={{ display: "flex", flexDirection: "column", gap: 2, padding: "var(--aiq-space-md) var(--aiq-space-xl)", backgroundColor: "var(--aiq-color-info-subtle, #eef4ff)", border: "1px solid var(--aiq-color-info, #3177dc)", borderRadius: "var(--aiq-radius-sm, 4px)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-info, #3177dc)" }}
          >
            <div style={{ fontWeight: 500 }}>Awaiting AssessIQ grading.</div>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", opacity: 0.85 }}>
              AssessIQ grades the written answers. When that is done you can review the final scores here and release them to the candidate.
            </div>
          </div>
        )}

        {evalStatus === "published" && (
          <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            This result has been released to the candidate. Scores can no longer be changed.
          </p>
        )}

        {/* Send back for re-grading — note is required and goes to AssessIQ. */}
        {showSendBack && evalStatus === "ready_to_publish" && (
          <div className="aiq-card aiq-no-print" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
            <h3 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "22px", fontWeight: 400, margin: 0, letterSpacing: "-0.015em", color: "var(--aiq-color-fg-primary)" }}>Send back for re-grading</h3>
            <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)", lineHeight: 1.5 }}>
              The attempt returns to the AssessIQ queue. Tell AssessIQ what to look at again.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
              <span style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "16px", fontWeight: 400, letterSpacing: "-0.01em", color: "var(--aiq-color-fg-primary)" }}>Note (required)</span>
              <textarea
                className="aiq-admin-longform-textarea"
                rows={3}
                maxLength={500}
                value={sendBackNote}
                onChange={(e) => setSendBackNote(e.target.value)}
                style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", padding: "var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", resize: "vertical" }}
              />
            </label>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
              <button
                type="button"
                className="aiq-btn aiq-btn-primary aiq-btn-sm"
                disabled={sendingBack || !sendBackNote.trim()}
                onClick={() => void handleSendBack()}
              >
                {sendingBack ? "Sending…" : "Send back"}
              </button>
              <button type="button" className="aiq-btn aiq-btn-ghost aiq-btn-sm" onClick={() => { setShowSendBack(false); setSendBackNote(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {(detail.section_scores ?? []).length > 0 && (
          <div className="aiq-card" data-help-id="admin.attempts.detail.section_scores" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-lg)" }}>
            <h3 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "22px", fontWeight: 400, margin: 0, letterSpacing: "-0.015em", color: "var(--aiq-color-fg-primary)" }}>Section scores</h3>
            <table style={{ borderCollapse: "collapse", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-primary)" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "4px 12px 4px 0", fontFamily: "var(--aiq-font-serif)", fontSize: "14px", fontWeight: 500, color: "var(--aiq-color-fg-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Section</th>
                  <th style={{ textAlign: "right", padding: "4px 12px", fontFamily: "var(--aiq-font-serif)", fontSize: "14px", fontWeight: 500, color: "var(--aiq-color-fg-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Score</th>
                  <th style={{ textAlign: "right", padding: "4px 0 4px 12px", fontFamily: "var(--aiq-font-serif)", fontSize: "14px", fontWeight: 500, color: "var(--aiq-color-fg-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {(detail.section_scores ?? []).map((s) => (
                  <tr key={s.index} style={{ borderTop: "1px solid var(--aiq-color-border)" }}>
                    <td style={{ padding: "6px 12px 6px 0" }}>{s.name}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{s.earned} / {s.max}</td>
                    <td style={{ padding: "6px 0 6px 12px", textAlign: "right" }}>
                      {s.max > 0 ? `${Math.round((s.earned / s.max) * 1000) / 10}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AttemptIntegrityCard attemptId={attempt.id} />

        <AttemptGradingPanel
          detail={detail}
          reload={reload}
          mode="review"
          apiBase="/admin"
          canOverride={evalStatus === "ready_to_publish"}
          onError={setError}
        />
      </div>

      {/* Publish summary modal: total score / per-question status / AI-failure
          callout BEFORE the result goes to the candidate. */}
      <ReleaseConfirmModal
        open={showReleaseModal}
        onConfirm={() => void handlePublish()}
        onCancel={() => setShowReleaseModal(false)}
        releasing={releasing}
        candidateEmail={attempt.isErased ? candidateName : (attempt.candidate_email ?? candidateName)}
        assessmentName={attempt.assessment_name}
        levelLabel={attempt.level_label}
        frozenQuestions={frozen_questions.map((q, idx) => ({
          id: q.id,
          type: q.type,
          topic: q.topic ?? "",
          points: q.points,
          position: q.position ?? idx + 1,
        }))}
        gradings={gradings}
      />
    </AdminShell>
  );
}
