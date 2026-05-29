// AssessIQ — ReleaseConfirmModal component.
//
// One-page review summary shown to admins before releasing an evaluated
// attempt to a candidate. Release publishes results immediately + triggers
// best-effort result-released email + cert if eligible — admins must see
// what they are releasing before confirming.
//
// INVARIANTS:
//  - Bands displayed as 0/25/50/75/100 — never raw floats.
//  - Plain text only — no dangerouslySetInnerHTML.
//  - Numbers in serif lining-nums tabular-nums for alignment.
//  - Click-outside and ESC both cancel the modal.

import React from "react";
import type { GradingsRow } from "@assessiq/ai-grading";

export interface ReleaseConfirmModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  releasing: boolean;
  candidateEmail: string;
  assessmentName: string;
  levelLabel: string;
  frozenQuestions: Array<{
    id: string;
    type: string;
    topic: string;
    points: number;
    position: number;
  }>;
  gradings: GradingsRow[];
}

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

const NUM_STYLE: React.CSSProperties = {
  fontVariantNumeric: "lining-nums tabular-nums",
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function ReleaseConfirmModal({
  open,
  onConfirm,
  onCancel,
  releasing,
  candidateEmail,
  assessmentName,
  levelLabel,
  frozenQuestions,
  gradings,
}: ReleaseConfirmModalProps): React.ReactElement | null {
  // ESC key handler
  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  // Active gradings: no override_of (they are the canonical committed grades)
  const activeGradings = gradings.filter((g) => g.override_of === null);

  // Map question_id → active grading for quick lookup
  const gradingByQuestion = new Map<string, GradingsRow>();
  for (const g of activeGradings) {
    gradingByQuestion.set(g.question_id, g);
  }

  // Summary stats
  let sumScoreEarned = 0;
  let sumScoreMax = 0;
  let gradedCount = 0;
  let bandSum = 0;
  let bandCount = 0;

  for (const q of frozenQuestions) {
    sumScoreMax += q.points;
    const g = gradingByQuestion.get(q.id);
    if (g) {
      gradedCount++;
      sumScoreEarned += g.score_earned ?? 0;
      if (g.reasoning_band !== null && g.reasoning_band !== undefined) {
        bandSum += BAND_PCT[g.reasoning_band] ?? 0;
        bandCount++;
      }
    }
  }

  const avgBand = bandCount > 0 ? Math.round(bandSum / bandCount) : null;
  const scorePct =
    sumScoreMax > 0 ? Math.round((sumScoreEarned / sumScoreMax) * 100) : 0;

  // AI-failure count
  const aiFailCount = gradings.filter(
    (g) =>
      (g.error_class !== null &&
        g.error_class !== undefined &&
        g.error_class.startsWith("AIG_")) ||
      (g.grader === "admin_override" &&
        g.error_class !== null &&
        g.error_class !== undefined)
  ).length;

  // Sorted questions
  const sortedQuestions = [...frozenQuestions].sort(
    (a, b) => a.position - b.position
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rcm-heading"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--aiq-space-md)",
        background: "rgba(0,0,0,0.55)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* Card */}
      <div
        className="aiq-card"
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--aiq-color-bg-base)",
          borderRadius: "var(--aiq-radius-md)",
          padding: "var(--aiq-space-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-md)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Heading */}
        <div>
          <h2
            id="rcm-heading"
            style={{
              margin: 0,
              fontFamily: "var(--aiq-font-serif)",
              fontSize: "var(--aiq-text-xl)",
              color: "var(--aiq-color-fg-primary)",
              fontWeight: 600,
            }}
          >
            Release evaluation to candidate?
          </h2>
          <p
            style={{
              margin: "var(--aiq-space-xs) 0 0",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-secondary)",
              fontFamily: "var(--aiq-font-sans)",
            }}
          >
            <span
              style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)" }}
            >
              {candidateEmail}
            </span>
            {" · "}
            {assessmentName}
            {" · Level "}
            {levelLabel}
          </p>
        </div>

        {/* Summary stat cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "var(--aiq-space-sm)",
          }}
        >
          {/* Total score */}
          <div
            className="aiq-card"
            style={{
              padding: "var(--aiq-space-md)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "var(--aiq-color-bg-sunken)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Total score
            </span>
            <span
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-2xl)",
                color: "var(--aiq-color-fg-primary)",
                fontWeight: 600,
                ...NUM_STYLE,
              }}
            >
              {sumScoreEarned}/{sumScoreMax}
            </span>
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-secondary)",
                ...NUM_STYLE,
              }}
            >
              {scorePct}%
            </span>
          </div>

          {/* Questions graded */}
          <div
            className="aiq-card"
            style={{
              padding: "var(--aiq-space-md)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "var(--aiq-color-bg-sunken)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Questions graded
            </span>
            <span
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-2xl)",
                color: "var(--aiq-color-fg-primary)",
                fontWeight: 600,
                ...NUM_STYLE,
              }}
            >
              {gradedCount}/{frozenQuestions.length}
            </span>
          </div>

          {/* Average band */}
          <div
            className="aiq-card"
            style={{
              padding: "var(--aiq-space-md)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "var(--aiq-color-bg-sunken)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Average band
            </span>
            <span
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-2xl)",
                color: "var(--aiq-color-fg-primary)",
                fontWeight: 600,
                ...NUM_STYLE,
              }}
            >
              {avgBand !== null ? `${avgBand}%` : "—"}
            </span>
          </div>
        </div>

        {/* AI-failure callout — only when present */}
        {aiFailCount > 0 && (
          <div
            className="aiq-banner aiq-banner-warning"
            style={{ fontSize: "var(--aiq-text-sm)" }}
          >
            {aiFailCount} question{aiFailCount === 1 ? "" : "s"} are flagged for
            review (AIG_* error class) and were NOT auto-committed. Releasing
            publishes only the questions that have committed grades.
          </div>
        )}

        {/* Per-question table */}
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--aiq-color-border)",
                  color: "var(--aiq-color-fg-muted)",
                  fontSize: "var(--aiq-text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                <th style={{ textAlign: "left", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", fontWeight: 500 }}>Q</th>
                <th style={{ textAlign: "left", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", fontWeight: 500 }}>Type / Topic</th>
                <th style={{ textAlign: "right", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", fontWeight: 500 }}>Band</th>
                <th style={{ textAlign: "right", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", fontWeight: 500 }}>Score</th>
                <th style={{ textAlign: "center", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", fontWeight: 500 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedQuestions.map((q) => {
                const g = gradingByQuestion.get(q.id);
                const band = g?.reasoning_band ?? null;
                const bandPct = band !== null ? (BAND_PCT[band] ?? 0) : null;
                const hasAigError =
                  g?.error_class !== null &&
                  g?.error_class !== undefined &&
                  g.error_class.startsWith("AIG_");

                let statusLabel: string;
                let statusBg: string;
                let statusColor: string;
                if (!g) {
                  statusLabel = "ungraded";
                  statusBg = "var(--aiq-color-bg-sunken)";
                  statusColor = "var(--aiq-color-fg-muted)";
                } else if (hasAigError) {
                  statusLabel = "needs review";
                  statusBg = "var(--aiq-color-warning-soft, #fef3c7)";
                  statusColor = "var(--aiq-color-warning, #d97706)";
                } else {
                  statusLabel = "graded";
                  statusBg = "var(--aiq-color-success-soft)";
                  statusColor = "var(--aiq-color-success)";
                }

                return (
                  <tr
                    key={q.id}
                    style={{ borderBottom: "1px solid var(--aiq-color-border)" }}
                  >
                    {/* Q-label chip */}
                    <td style={{ padding: "var(--aiq-space-xs) var(--aiq-space-sm)", whiteSpace: "nowrap" }}>
                      <span
                        style={{
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          padding: "1px 6px",
                          borderRadius: "var(--aiq-radius-pill)",
                          background: "var(--aiq-color-accent-soft)",
                          color: "var(--aiq-color-accent)",
                        }}
                      >
                        Q{q.position}
                      </span>
                    </td>

                    {/* Type / Topic */}
                    <td style={{ padding: "var(--aiq-space-xs) var(--aiq-space-sm)" }}>
                      <span style={{ color: "var(--aiq-color-fg-primary)" }}>
                        {q.type}
                      </span>
                      <span style={{ color: "var(--aiq-color-fg-muted)", marginLeft: "var(--aiq-space-xs)" }}>
                        {truncate(q.topic, 40)}
                      </span>
                    </td>

                    {/* Band */}
                    <td
                      style={{
                        padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                        textAlign: "right",
                        fontFamily: "var(--aiq-font-serif)",
                        color: "var(--aiq-color-fg-primary)",
                        whiteSpace: "nowrap",
                        ...NUM_STYLE,
                      }}
                    >
                      {bandPct !== null ? `Band ${band} · ${bandPct}%` : "—"}
                    </td>

                    {/* Score */}
                    <td
                      style={{
                        padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
                        textAlign: "right",
                        fontFamily: "var(--aiq-font-serif)",
                        color: "var(--aiq-color-fg-secondary)",
                        whiteSpace: "nowrap",
                        ...NUM_STYLE,
                      }}
                    >
                      {g ? `${g.score_earned}/${g.score_max}` : "—"}
                    </td>

                    {/* Status chip */}
                    <td style={{ padding: "var(--aiq-space-xs) var(--aiq-space-sm)", textAlign: "center" }}>
                      <span
                        style={{
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          padding: "1px 8px",
                          borderRadius: "var(--aiq-radius-pill)",
                          background: statusBg,
                          color: statusColor,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {statusLabel}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--aiq-space-sm)",
            paddingTop: "var(--aiq-space-sm)",
            borderTop: "1px solid var(--aiq-color-border)",
          }}
        >
          <button
            className="aiq-btn aiq-btn-ghost"
            onClick={onCancel}
            disabled={releasing}
            type="button"
          >
            Cancel
          </button>
          <button
            className="aiq-btn aiq-btn-primary"
            onClick={onConfirm}
            disabled={releasing}
            data-help-id="admin.attempts.release_confirm"
            type="button"
          >
            {releasing ? "Releasing…" : "Release to candidate"}
          </button>
        </div>
      </div>
    </div>
  );
}

ReleaseConfirmModal.displayName = "ReleaseConfirmModal";
