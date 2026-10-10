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

import { questionTypeLabel } from "../lib/labels.js";
import React from "react";
import { Modal, Table, type ColumnDef } from "@assessiq/ui-system";
import type { GradingsRow } from "@assessiq/ai-grading";
import { effectiveGradings } from "../lib/evaluation.js";

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
  if (!open) return null;

  // question_id → the EFFECTIVE grading (newest row; an override wins), i.e. the
  // grade that is actually counted — so scores changed by an override show here.
  const gradingByQuestion = effectiveGradings(gradings);

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

  const columns: ColumnDef<(typeof sortedQuestions)[number]>[] = [
    {
      key: "q",
      label: "Q",
      width: 64,
      render: (q) => (
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
      ),
    },
    {
      key: "type",
      label: "Type / Topic",
      width: "minmax(160px, 1fr)",
      render: (q) => (
        <span>
          <span style={{ color: "var(--aiq-color-fg-primary)" }}>{questionTypeLabel(q.type)}</span>
          <span style={{ color: "var(--aiq-color-fg-muted)", marginLeft: "var(--aiq-space-xs)" }}>
            {truncate(q.topic, 40)}
          </span>
        </span>
      ),
    },
    {
      key: "band",
      label: "Score band",
      width: 150,
      render: (q) => {
        const band = gradingByQuestion.get(q.id)?.reasoning_band ?? null;
        return (
          <span style={{ fontFamily: "var(--aiq-font-serif)", ...NUM_STYLE }}>
            {band !== null ? `Score band ${band} · ${BAND_PCT[band] ?? 0}%` : "—"}
          </span>
        );
      },
    },
    {
      key: "score",
      label: "Score",
      width: 80,
      render: (q) => {
        const g = gradingByQuestion.get(q.id);
        return (
          <span style={{ fontFamily: "var(--aiq-font-serif)", color: "var(--aiq-color-fg-secondary)", ...NUM_STYLE }}>
            {g ? `${g.score_earned}/${g.score_max}` : "—"}
          </span>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      width: 120,
      render: (q) => {
        const g = gradingByQuestion.get(q.id);
        const hasAigError =
          g?.error_class !== null && g?.error_class !== undefined && g.error_class.startsWith("AIG_");
        let statusLabel = "graded";
        let statusBg = "var(--aiq-color-success-soft)";
        let statusColor = "var(--aiq-color-success)";
        if (!g) {
          statusLabel = "ungraded";
          statusBg = "var(--aiq-color-bg-sunken)";
          statusColor = "var(--aiq-color-fg-muted)";
        } else if (hasAigError) {
          statusLabel = "needs review";
          statusBg = "var(--aiq-color-warning-soft, #fef3c7)";
          statusColor = "var(--aiq-color-warning, #d97706)";
        }
        return (
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
        );
      },
    },
  ];

  return (
    <Modal open={open} onClose={onCancel} title="Release result to candidate?" width={720}>
      <>
        <div>
          <p
            style={{
              margin: 0,
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
            {" · Difficulty "}
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
              Average score band
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
            shows only the questions that have committed grades.
          </div>
        )}

        {/* Per-question table */}
        <div style={{ overflowX: "auto" }}>
          <Table data={sortedQuestions} columns={columns} emptyMessage="No questions." />
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
      </>
    </Modal>
  );
}

ReleaseConfirmModal.displayName = "ReleaseConfirmModal";
