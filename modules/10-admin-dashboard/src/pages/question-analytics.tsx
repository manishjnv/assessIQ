// AssessIQ - Question analytics for one assessment (X6b). /admin/assessments/:id/questions
//
// Read only. Per question: attempts, share correct, average time, MCQ answer split and a
// "possibly bad question" chip. The chip is a hint only: it never changes marks or review state.
// Fetches: GET /admin/assessments/:id/question-analytics (see api/question-analytics.ts).
// INVARIANTS: no claude/anthropic imports or copy.

import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError } from "../api.js";
import { getQuestionAnalyticsApi } from "../api/question-analytics.js";
import type { QuestionAnalyticsItem } from "../api/question-analytics.js";
import { questionTypeLabel } from "../lib/labels.js";

const BODY_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-primary)",
};
const MUTED_STYLE: React.CSSProperties = { ...BODY_STYLE, color: "var(--aiq-color-fg-muted)" };
const NUM_STYLE: React.CSSProperties = { ...BODY_STYLE, fontVariantNumeric: "tabular-nums" };

function letter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `#${i + 1}`;
}

function errorText(err: unknown): string {
  return err instanceof AdminApiError ? err.apiError.message : "Could not load question analytics. Try again.";
}

export function QuestionAnalytics(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [items, setItems] = useState<QuestionAnalyticsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    getQuestionAnalyticsApi(id)
      .then((r) => { if (!cancelled) { setItems(r); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const columns: ColumnDef<QuestionAnalyticsItem>[] = [
    { key: "position", label: "#", width: 48, render: (r) => <span style={NUM_STYLE}>{r.position}</span> },
    {
      key: "stem", label: "Question",
      render: (r) => (
        <span style={BODY_STYLE}>
          {r.stem_preview || <span style={MUTED_STYLE}>No text</span>}
          <span style={{ ...MUTED_STYLE, marginLeft: 8 }}>{questionTypeLabel(r.type)}</span>
        </span>
      ),
    },
    { key: "attempts", label: "Attempts", width: 90, render: (r) => <span style={NUM_STYLE}>{r.attempts}</span> },
    {
      key: "share", label: "Correct", width: 90,
      render: (r) => (
        <HelpTip helpId="admin.question_analytics.share">
          <span style={NUM_STYLE}>{r.share_correct === null ? "-" : `${Math.round(r.share_correct * 100)}%`}</span>
        </HelpTip>
      ),
    },
    {
      key: "time", label: "Avg time", width: 100,
      render: (r) => (
        <HelpTip helpId="admin.question_analytics.time">
          <span style={NUM_STYLE}>{r.avg_time_seconds === null ? "-" : `${r.avg_time_seconds}s`}</span>
        </HelpTip>
      ),
    },
    {
      key: "split", label: "Answer split",
      render: (r) => (
        <HelpTip helpId="admin.question_analytics.split">
          <span style={r.distractors ? NUM_STYLE : MUTED_STYLE}>
            {r.distractors ? r.distractors.map((d) => `${letter(d.option_index)} ${d.count}`).join(" · ") : "-"}
          </span>
        </HelpTip>
      ),
    },
    {
      key: "flag", label: "Check", width: 220,
      render: (r) =>
        r.possibly_bad ? (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <HelpTip helpId="admin.question_analytics.flag">
              <Chip variant="warn">Possibly bad question</Chip>
            </HelpTip>
            <HelpTip helpId="admin.question_analytics.review_link">
              <Link
                to={`/admin/question-bank/${r.pack_id}/review`}
                aria-label={`Open review for question ${r.position}`}
                title={r.flag_reason ?? undefined}
              >
                Open review
              </Link>
            </HelpTip>
          </span>
        ) : (
          <span style={MUTED_STYLE}>-</span>
        ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Assessments", "Question analytics"]} helpPage="admin.question_analytics">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <div data-help-id="admin.question_analytics.page">
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Question analytics.
          </h1>
          <p style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 640 }}>
            How each question performed in this assessment. Only published results count. A flag is a hint and changes no marks.
          </p>
          {id ? <Link to={`/admin/assessments/${id}`} style={{ ...BODY_STYLE, display: "inline-block", marginTop: 8 }}>Back to assessment</Link> : null}
        </div>

        <div role="status" aria-live="polite" style={MUTED_STYLE}>
          {loading ? "Loading questions" : ""}
        </div>
        {error ? <div role="alert" style={{ ...BODY_STYLE, color: "var(--aiq-color-danger)" }}>{error}</div> : null}
        {!error && !loading && items.length === 0 ? (
          <div style={MUTED_STYLE}>No question was served in this assessment yet.</div>
        ) : null}
        {items.length > 0 ? (
          <div className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
            <Table columns={columns} data={items} loading={loading} emptyMessage="No questions." />
          </div>
        ) : null}
      </div>
    </AdminShell>
  );
}
