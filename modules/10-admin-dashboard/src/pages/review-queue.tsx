// AssessIQ - Review queue (EXP-18). /admin/review-queue
//
// One list of questions across all question sets, filtered by review state. Each row links to the
// pack review page (/admin/question-bank/:id/review), where the actions are taken.
//
// Fetches: GET /api/admin/review-queue (see api/review.ts).
// INVARIANTS: no claude/anthropic imports or copy. The server decides which questions an admin sees.

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Chip, Table, formatDateTime } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError } from "../api.js";
import { getReviewQueueApi } from "../api/review.js";
import type { ReviewCounts, ReviewQueueItem, ReviewQueueState } from "../api/review.js";

export const REVIEW_QUEUE_PAGE_SIZE = 25;
const PREVIEW_MAX = 140;

const FILTERS: ReadonlyArray<{ id: ReviewQueueState; label: string; count: (c: ReviewCounts) => number }> = [
  { id: "open", label: "Needs review", count: (c) => c.in_review + c.disputed + c.needs_fix },
  { id: "in_review", label: "In review", count: (c) => c.in_review },
  { id: "disputed", label: "Disputed", count: (c) => c.disputed },
  { id: "needs_fix", label: "Needs fix", count: (c) => c.needs_fix },
  { id: "verified", label: "Verified", count: (c) => c.verified },
  { id: "none", label: "Not set", count: (c) => c.none },
  { id: "all", label: "All", count: (c) => c.in_review + c.disputed + c.needs_fix + c.verified + c.none },
];

const STATE_LABEL: Record<string, string> = {
  in_review: "In review",
  verified: "Verified",
  disputed: "Disputed",
  needs_fix: "Needs fix",
  none: "Not set",
};

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--aiq-color-fg-muted)",
};

const BODY_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-primary)",
};

const ERROR_STYLE: React.CSSProperties = { ...BODY_STYLE, color: "var(--aiq-color-danger)" };

/** Plain words for a failed call. The server message is shown when the server sent one. */
function queueErrorText(err: unknown): string {
  return err instanceof AdminApiError ? err.apiError.message : "Could not load the review queue. Try again.";
}

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

export function ReviewQueue(): React.ReactElement {
  const [filter, setFilter] = useState<ReviewQueueState>("open");
  const [page, setPage] = useState(1);
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getReviewQueueApi({ state: filter, page, pageSize: REVIEW_QUEUE_PAGE_SIZE })
      .then((r) => {
        if (cancelled) return;
        setCounts(r.counts);
        setItems(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(queueErrorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filter, page]);

  const pages = Math.max(1, Math.ceil(total / REVIEW_QUEUE_PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * REVIEW_QUEUE_PAGE_SIZE + 1;
  const to = Math.min(total, page * REVIEW_QUEUE_PAGE_SIZE);

  const columns: ColumnDef<ReviewQueueItem>[] = [
    { key: "pack_name", label: "Question set", render: (r) => r.pack_name },
    { key: "topic", label: "Topic", render: (r) => r.topic },
    { key: "type", label: "Type", render: (r) => r.type },
    {
      key: "state", label: "State",
      render: (r) => (
        <HelpTip helpId="admin.review_queue.state">
          <Chip>{STATE_LABEL[r.review_state ?? "none"] ?? "Not set"}</Chip>
        </HelpTip>
      ),
    },
    {
      key: "latest_note", label: "Latest note",
      render: (r) => (
        <HelpTip helpId="admin.review_queue.latest_note">
          <span style={{ ...BODY_STYLE, color: r.latest_note ? undefined : "var(--aiq-color-fg-muted)" }}>
            {r.latest_note ? preview(r.latest_note.note) : "No note"}
          </span>
        </HelpTip>
      ),
    },
    { key: "updated_at", label: "Updated", render: (r) => formatDateTime(r.updated_at) },
    {
      key: "open", label: "", width: 140,
      render: (r) => (
        <HelpTip helpId="admin.review_queue.open">
          <Link
            to={`/admin/question-bank/${r.pack_id}/review`}
            aria-label={`Open review for ${r.topic} in ${r.pack_name}`}
          >
            Open review
          </Link>
        </HelpTip>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Question bank", "Review queue"]} helpPage="admin.review_queue">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <div data-help-id="admin.review_queue.page">
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Review queue.
          </h1>
          <p style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 640 }}>
            Questions from all question sets that need a check. Open a question to verify it, mark it as needing a fix or dispute it.
          </p>
        </div>

        {counts ? (
          <HelpTip helpId="admin.review_queue.filter">
            <div role="tablist" aria-label="Review state" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={`aiq-btn aiq-btn-sm ${filter === f.id ? "aiq-btn-primary" : "aiq-btn-outline"}`}
                  onClick={() => { setFilter(f.id); setPage(1); }}
                >
                  {f.label} ({f.count(counts)})
                </button>
              ))}
            </div>
          </HelpTip>
        ) : null}

        <div role="status" aria-live="polite" style={LABEL_STYLE}>
          {loading ? "Loading questions" : error ? "" : total === 0 ? "No questions match this filter." : `Showing ${from} to ${to} of ${total} questions.`}
        </div>

        {error ? <div role="alert" style={ERROR_STYLE}>{error}</div> : null}

        {!error && !loading && items.length === 0 ? (
          <div style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-muted)", padding: "var(--aiq-space-lg) 0" }}>
            {filter === "open" ? "Nothing waits for review." : "No questions match this filter."}
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
            <Table columns={columns} data={items} loading={loading} emptyMessage="No questions match this filter." />
          </div>
        ) : null}

        {!error && total > 0 ? (
          <HelpTip helpId="admin.review_queue.paging">
            <nav aria-label="Review queue pages" style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center" }}>
              <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span style={LABEL_STYLE}>Page {page} of {pages}</span>
              <button type="button" className="aiq-btn aiq-btn-outline aiq-btn-sm" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          </HelpTip>
        ) : null}
      </div>
    </AdminShell>
  );
}
