// AssessIQ — Admin attempts list page.
//
// /admin/attempts — filterable table of all attempts across cycles.
// Consumes: GET /api/admin/attempts (existing endpoint from 06-attempt-engine
// admin routes — candidates list merged at admin level via 07's queue).
//
// Filter state stored in sessionStorage (per CLAUDE.md anti-pattern guard).
// Tabs: All | Submitted | Pending grading | Graded | Released.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, Table, ErasedChip } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";
import { attemptStatusDisplay } from "../lib/status.js";
import { formatTimestamp } from "../lib/format.js";

type AttemptStatus = "submitted" | "pending_admin_grading" | "graded" | "released" | "auto_submitted";

interface AttemptListItem {
  id: string;
  candidate_email: string;
  candidate_name: string;
  isErased: boolean;
  assessment_name: string;
  level_label: string;
  status: AttemptStatus;
  submitted_at: string | null;
  started_at: string;
}

interface AttemptsResponse {
  items: AttemptListItem[];
  total: number;
}

const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Submitted", value: "submitted" },
  { label: "Pending grading", value: "pending_admin_grading" },
  { label: "Graded", value: "graded" },
  { label: "Released", value: "released" },
];

const SESSION_KEY = "aiq.admin.attempts.statusFilter";

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

export function AdminAttempts(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<AttemptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    try { return sessionStorage.getItem(SESSION_KEY) ?? ""; } catch { return ""; }
  });

  const fetchAttempts = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}&limit=100` : "?limit=100";
      const data = await adminApi<AttemptsResponse>(`/admin/attempts${qs}`);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load attempts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAttempts(statusFilter);
  }, [fetchAttempts, statusFilter]);

  function handleTabChange(val: string) {
    setStatusFilter(val);
    try { sessionStorage.setItem(SESSION_KEY, val); } catch { /* ignore */ }
  }

  const columns: ColumnDef<AttemptListItem>[] = [
    {
      key: "candidate_email",
      label: "Candidate",
      sortable: true,
      render: (row: AttemptListItem) => (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--aiq-space-xs)",
            color: row.isErased ? "var(--aiq-color-fg-muted)" : undefined,
          }}
        >
          {row.candidate_name}
          {row.isErased && <ErasedChip />}
        </span>
      ),
    },
    { key: "assessment_name", label: "Assessment", sortable: true },
    { key: "level_label", label: "Level", sortable: true },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (row: AttemptListItem) => {
        const s = attemptStatusDisplay(row.status);
        return <Chip variant={s.variant}>{s.label}</Chip>;
      },
    },
    {
      key: "submitted_at",
      label: "Submitted",
      sortable: true,
      render: (row: AttemptListItem) => (
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          {formatTimestamp(row.submitted_at)}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 96,
      render: (row: AttemptListItem) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-ghost aiq-btn-sm"
          onClick={() => navigate(`/admin/attempts/${row.id}`)}
        >
          View →
        </button>
      ),
    },
  ];

  const sortedRows = React.useMemo(() => (sortBy ? sortRows(items, sortBy, sortDir) : items), [items, sortBy, sortDir]);

  return (
    <AdminShell breadcrumbs={["Attempts"]} helpPage="admin.attempts.list">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{items.length} attempt{items.length !== 1 ? "s" : ""}</Chip>
          </div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Attempts.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            All candidate submissions across every active assessment cycle.
          </p>
        </div>

        {/* Status filter row — quiet ghost tabs, right-aligned results count */}
        <div
          className="aiq-admin-filter-strip"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--aiq-space-md)",
            flexWrap: "wrap",
            borderBottom: "1px solid var(--aiq-color-border)",
            paddingBottom: "var(--aiq-space-sm)",
          }}
        >
          <div style={{ display: "flex", gap: "var(--aiq-space-2xs)", flexWrap: "wrap" }}>
            {STATUS_TABS.map((tab) => {
              const isActive = statusFilter === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => handleTabChange(tab.value)}
                  aria-pressed={isActive}
                  className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                  style={{
                    background: isActive ? "var(--aiq-color-accent-soft)" : "transparent",
                    color: isActive ? "var(--aiq-color-accent)" : "var(--aiq-color-fg-secondary)",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <span style={{ flex: 1 }} />
          {!loading && !error && (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              {items.length} {items.length === 1 ? "result" : "results"}
            </span>
          )}
        </div>

        {error && (
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {error}
          </div>
        )}

        <div
          className="aiq-card"
          data-density="compact"
          style={{ padding: 0, overflow: "hidden" }}
        >
          <div className="aiq-admin-table-scroll">
            {!loading && items.length === 0 ? (
              <div style={{ padding: "var(--aiq-space-3xl) var(--aiq-space-lg)", textAlign: "center" }}>
                <p
                  style={{
                    fontFamily: "var(--aiq-font-serif)",
                    fontSize: "var(--aiq-text-xl)",
                    fontWeight: 400,
                    margin: "0 0 var(--aiq-space-sm)",
                    letterSpacing: "-0.015em",
                  }}
                >
                  No attempts {statusFilter ? "in this state" : "yet"}.
                </p>
                <p
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    color: "var(--aiq-color-fg-muted)",
                    margin: "0 auto",
                    maxWidth: 360,
                  }}
                >
                  {statusFilter
                    ? "Try a different filter, or wait for new submissions."
                    : "Candidate submissions will appear here as they come in."}
                </p>
              </div>
            ) : (
              <Table<AttemptListItem>
                data={sortedRows}
                columns={columns}
                loading={loading}
                {...(sortBy ? { sortBy } : {})}
                sortDir={sortDir}
                onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }}
                emptyMessage="No attempts found."
              />
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
