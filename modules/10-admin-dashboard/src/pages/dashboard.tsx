// AssessIQ — Admin Dashboard home page.
//
// /admin — shows KPI StatCards + grading queue table.
// Consumes: GET /api/admin/dashboard/queue (07-ai-grading)
//
// HelpProvider: page="admin.dashboard.home" (wrapped by AdminShell).
// Help IDs used: admin.grading.queue.row, admin.grading.queue.empty.
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - Filter state in sessionStorage only.
//  - Bands only in score display.
//
// Diverges from screens/dashboard.jsx because:
//  - Kit is candidate-facing; admin replaces "continue/performance/recommended"
//    panels with the grading queue — the primary admin work surface.
//  - Sparkline dropped: queue endpoint provides no time-series data.
//  - 3 stat cards (vs kit's 4): tenant-wide totals from the server (`counts`),
//    not the length of the capped queue list.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, StatCard, Table, formatDateTime, formatDayLine } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import type { QueueRow as BaseQueueRow } from "@assessiq/ai-grading";
import { AdminShell } from "../components/AdminShell.js";
import { useAdminSession } from "../session.js";
import { adminApi, AdminApiError } from "../api.js";
import { UsageBanner } from "../components/UsageBanner.js";
import { evaluationStatusOf } from "../lib/evaluation.js";
import type { EvaluationStatus } from "../lib/evaluation.js";
import { evaluationStatusDisplay } from "../lib/status.js";

/** Queue row + the result state the company sees (spec 2026-10-01 §5b). */
type QueueRow = BaseQueueRow & { evaluation_status?: EvaluationStatus };

interface QueueCounts {
  in_queue: number;
  awaiting_evaluation: number;
  ready_to_publish: number;
}

interface QueueResponse {
  items: QueueRow[];
  /** Tenant-wide totals from the server; `items` is capped by `limit`. */
  counts: QueueCounts;
}

type SortDir = "asc" | "desc";

/** Client-side row sort. Keys ending in `_at` sort as dates; numeric columns
 *  numerically; everything else case-insensitively. */
function sortRows<T>(rows: T[], key: string, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (key.endsWith("_at")) {
      const at = av ? new Date(av as string).getTime() : 0;
      const bt = bv ? new Date(bv as string).getTime() : 0;
      return sign * (at - bt);
    }
    if (typeof av === "number" && typeof bv === "number") return sign * (av - bv);
    const as = String(av ?? "").toLowerCase();
    const bs = String(bv ?? "").toLowerCase();
    return as < bs ? -1 * sign : as > bs ? 1 * sign : 0;
  });
}

function greetingPhrase(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}


export function AdminDashboard(): React.ReactElement {
  const navigate = useNavigate();
  const { session } = useAdminSession();
  const [queueItems, setQueueItems] = useState<QueueRow[]>([]);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<QueueResponse>("/admin/dashboard/queue?limit=50");
      setQueueItems(data.items);
      setCounts(data.counts ?? null);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchQueue();
    // Short-poll every 30s per the 13-notifications precedent
    const interval = setInterval(() => void fetchQueue(), 30_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const evalOf = (r: QueueRow): EvaluationStatus => evaluationStatusOf(r.status, r.evaluation_status);
  // Server totals, not the length of the capped list. Fallback to the list only
  // while an older API (no `counts`) is still running during a deploy.
  const totalCount = counts?.in_queue ?? queueItems.length;
  const awaitingCount = counts?.awaiting_evaluation ?? queueItems.filter((r) => evalOf(r) === "awaiting_evaluation").length;
  const readyCount = counts?.ready_to_publish ?? queueItems.filter((r) => evalOf(r) === "ready_to_publish").length;

  const displayName =
    (session?.user.email?.split("@")[0] ?? "").replace(/^./, (c) => c.toUpperCase()) || "Admin";

  const columns: ColumnDef<QueueRow>[] = [
    {
      key: "candidate_email",
      label: "Candidate",
      sortable: true,
      render: (row: QueueRow) => (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
          {row.candidate_email}
        </span>
      ),
    },
    { key: "assessment_name", label: "Assessment", sortable: true },
    { key: "level_label", label: "Difficulty", sortable: true },
    {
      key: "submitted_at",
      label: "Submitted",
      sortable: true,
      render: (row: QueueRow) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.submitted_at ? formatDateTime(row.submitted_at) : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (row: QueueRow) => {
        // "Awaiting evaluation" / "Ready to publish" / "Published" — never the raw enum.
        const s = evaluationStatusDisplay(evalOf(row));
        return <Chip variant={s.variant}>{s.label}</Chip>;
      },
    },
    {
      key: "action",
      label: "",
      width: 100,
      render: (row: QueueRow) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-outline aiq-btn-sm"
          onClick={() => navigate(`/admin/attempts/${row.attempt_id}`)}
        >
          Review
        </button>
      ),
    },
  ];

  const sortedRows = React.useMemo(
    () => (sortBy ? sortRows(queueItems, sortBy, sortDir) : queueItems),
    [queueItems, sortBy, sortDir],
  );

  return (
    <AdminShell breadcrumbs={["Dashboard"]} helpPage="admin.dashboard.home">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — kit dashboard.jsx header region */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: "var(--aiq-space-xs)",
              }}
            >
              {formatDayLine()}
            </div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 500,
                margin: 0,
                color: "var(--aiq-color-fg-primary)",
                letterSpacing: "-0.02em",
              }}
            >
              {greetingPhrase()}, {displayName}.
            </h1>
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}
          >
            <button
              type="button"
              className="aiq-btn aiq-btn-outline"
              onClick={() => void fetchQueue()}
            >
              Refresh
            </button>
            <button
              type="button"
              className="aiq-btn aiq-btn-primary"
              onClick={() => navigate("/admin/assessments")}
            >
              New assessment
            </button>
          </div>
        </div>

        {/* A2 — usage banner (fail-silent; renders nothing when status=unlimited or loading) */}
        <UsageBanner />

        {/* KPI row — 3 cards derived from queue status counts */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "var(--aiq-space-md)",
          }}
        >
          <StatCard label="In queue" value={totalCount} />
          <StatCard label="Awaiting grading" value={awaitingCount} />
          <StatCard label="Ready to release" value={readyCount} />
        </div>

        {/* Grading queue */}
        <section>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--aiq-space-md)",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 500,
                margin: 0,
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              Results queue.
            </h2>
            {totalCount > queueItems.length && queueItems.length > 0 && (
              <span
                style={{
                  fontFamily: "var(--aiq-font-mono)",
                  fontSize: "var(--aiq-text-xs)",
                  color: "var(--aiq-color-fg-muted)",
                }}
              >
                Showing the oldest {queueItems.length} of {totalCount}
              </span>
            )}
          </div>

          {error && (
            <div
              style={{
                padding: "var(--aiq-space-md)",
                color: "var(--aiq-color-danger)",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
              }}
            >
              {error}
            </div>
          )}

          <div className="aiq-card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="aiq-admin-table-scroll">
              <Table<QueueRow>
                data={sortedRows}
                columns={columns}
                loading={loading}
                {...(sortBy ? { sortBy } : {})}
                sortDir={sortDir}
                onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }}
                emptyMessage="No results."
              />
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
