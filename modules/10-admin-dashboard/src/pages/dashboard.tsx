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
//  - 3 stat cards (vs kit's 4): counts derived from queue status.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { StatCard, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import type { QueueRow } from "@assessiq/ai-grading";
import { AdminShell } from "../components/AdminShell.js";
import { useAdminSession } from "../session.js";
import { adminApi, AdminApiError } from "../api.js";
import { UsageBanner } from "../components/UsageBanner.js";

interface QueueResponse {
  items: QueueRow[];
}

function greetingPhrase(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function dateLine(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
    .format(new Date())
    .replace(",", " ·");
}

export function AdminDashboard(): React.ReactElement {
  const navigate = useNavigate();
  const { session } = useAdminSession();
  const [queueItems, setQueueItems] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<QueueResponse>("/admin/dashboard/queue?limit=50");
      setQueueItems(data.items);
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

  const submittedCount = queueItems.filter((r) => r.status === "submitted").length;
  const pendingCount = queueItems.filter((r) => r.status === "pending_admin_grading").length;
  const totalCount = queueItems.length;

  const displayName =
    (session?.user.email?.split("@")[0] ?? "").replace(/^./, (c) => c.toUpperCase()) || "Admin";

  const columns: ColumnDef<QueueRow>[] = [
    {
      key: "candidate_email",
      label: "Candidate",
      render: (row: QueueRow) => (
        <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
          {row.candidate_email}
        </span>
      ),
    },
    { key: "assessment_name", label: "Assessment" },
    { key: "level_label", label: "Level" },
    {
      key: "submitted_at",
      label: "Submitted",
      render: (row: QueueRow) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.submitted_at ? new Date(row.submitted_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row: QueueRow) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            padding: "1px 8px",
            borderRadius: "var(--aiq-radius-pill)",
            background:
              row.status === "pending_admin_grading"
                ? "var(--aiq-color-accent-soft)"
                : "var(--aiq-color-bg-sunken)",
            color:
              row.status === "pending_admin_grading"
                ? "var(--aiq-color-accent)"
                : "var(--aiq-color-fg-secondary)",
          }}
        >
          {row.status}
        </span>
      ),
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
              {dateLine()}
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
          <StatCard label="Submitted" value={submittedCount} />
          <StatCard label="Awaiting review" value={pendingCount} />
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
              Grading queue.
            </h2>
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
                data={queueItems}
                columns={columns}
                loading={loading}
                emptyMessage="No attempts awaiting grading."
              />
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
