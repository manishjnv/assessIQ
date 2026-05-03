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
import { Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

type AttemptStatus = "submitted" | "pending_admin_grading" | "graded" | "released" | "auto_submitted";

interface AttemptListItem {
  id: string;
  candidate_email: string;
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

function statusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "graded": return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "released": return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
    case "pending_admin_grading": return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    default: return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

const SESSION_KEY = "aiq.admin.attempts.statusFilter";

export function AdminAttempts(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<AttemptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    { key: "candidate_email", label: "Candidate" },
    { key: "assessment_name", label: "Assessment" },
    { key: "level_label", label: "Level" },
    {
      key: "status",
      label: "Status",
      render: (row: AttemptListItem) => {
        const c = statusColor(row.status);
        return (
          <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.04em", padding: "1px 8px", borderRadius: "var(--aiq-radius-pill)", background: c.bg, color: c.color }}>
            {row.status}
          </span>
        );
      },
    },
    {
      key: "submitted_at",
      label: "Submitted",
      render: (row: AttemptListItem) => (
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          {row.submitted_at ? new Date(row.submitted_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 80,
      render: (row: AttemptListItem) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-outline aiq-btn-sm"
          onClick={() => navigate(`/admin/attempts/${row.id}`)}
        >
          Open
        </button>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Attempts"]} helpPage="admin.attempts.list">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
          Attempts.
        </h1>

        {/* Status filter tabs */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`aiq-btn aiq-btn-sm ${statusFilter === tab.value ? "aiq-btn-primary" : "aiq-btn-outline"}`}
              onClick={() => handleTabChange(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {error}
          </div>
        )}

        <div className="aiq-card" style={{ padding: 0, overflow: "hidden" }}>
          <Table<AttemptListItem>
            data={items}
            columns={columns}
            loading={loading}
            emptyMessage="No attempts found."
          />
        </div>
      </div>
    </AdminShell>
  );
}
