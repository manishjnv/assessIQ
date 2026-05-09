// AssessIQ — Admin Assessments list page.
//
// /admin/assessments — list of assessment cycles in the current tenant.
//
// NOTE: "Cycles" in the original product spec maps to "Assessments" in the
// backend. The backend noun is "assessments" (05-assessment-lifecycle module).
// The sidebar nav label is "Assessments"; this note is here so future
// maintainers don't confuse the two terms.
//
// Filter state: URL query params (?status=draft) per CLAUDE.md anti-pattern
// guard (no localStorage / sessionStorage for filter state — shareable links,
// no cross-tenant leak risk).
//
// "+ New Assessment" opens an inline form (consistent with question-bank.tsx).
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - Filter state in URL query params only.
//  - Empty-state renders; no hardcoded fake rows.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

type AssessmentStatus = "draft" | "published" | "active" | "closed";

interface InvitationCounts {
  total: number;
  pending: number;
  viewed: number;
  started: number;
  submitted: number;
  expired: number;
}

interface AssessmentListItem {
  id: string;
  name: string;
  status: AssessmentStatus;
  pack_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  invitations?: InvitationCounts;
}

interface AssessmentsResponse {
  items: AssessmentListItem[];
  total: number;
}

const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Active", value: "active" },
  { label: "Closed", value: "closed" },
];

function assessmentStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "active":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "published":
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
    case "closed":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-secondary)" };
  }
}

interface NewAssessmentForm {
  name: string;
  pack_id: string;
  opens_at: string;
  closes_at: string;
}

export function AdminAssessments(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";

  const [items, setItems] = useState<AssessmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewAssessmentForm>({
    name: "",
    pack_id: "",
    opens_at: "",
    closes_at: "",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchAssessments = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (status) qs.set("status", status);
      const data = await adminApi<AssessmentsResponse>(`/admin/assessments?${qs.toString()}`);
      setItems(data.items);
    } catch (err) {
      setError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to load assessments.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAssessments(statusFilter);
  }, [fetchAssessments, statusFilter]);

  function handleStatusChange(val: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("status", val);
        else next.delete("status");
        return next;
      },
      { replace: true },
    );
  }

  async function handleCreateAssessment(e: React.FormEvent) {
    e.preventDefault();
    if (!newForm.name.trim()) {
      setCreateError("Assessment name is required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const body: Record<string, unknown> = { name: newForm.name.trim() };
      if (newForm.pack_id.trim()) body.pack_id = newForm.pack_id.trim();
      if (newForm.opens_at) body.opens_at = new Date(newForm.opens_at).toISOString();
      if (newForm.closes_at) body.closes_at = new Date(newForm.closes_at).toISOString();
      const created = await adminApi<{ id: string }>("/admin/assessments", {
        method: "POST",
        body: JSON.stringify(body),
      });
      navigate(`/admin/assessments/${created.id}`);
    } catch (err) {
      setCreateError(
        err instanceof AdminApiError
          ? err.apiError.message
          : "Failed to create assessment.",
      );
      setCreating(false);
    }
  }

  const columns: ColumnDef<AssessmentListItem>[] = [
    {
      key: "name",
      label: "Name",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontWeight: 500,
            fontSize: "var(--aiq-text-sm)",
          }}
        >
          {row.name}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row: AssessmentListItem) => {
        const c = assessmentStatusColor(row.status);
        return (
          <span
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              padding: "1px 8px",
              borderRadius: "var(--aiq-radius-pill)",
              background: c.bg,
              color: c.color,
            }}
          >
            {row.status}
          </span>
        );
      },
    },
    {
      key: "invitations",
      label: "Invited",
      render: (row: AssessmentListItem) => {
        const inv = row.invitations;
        const total = inv?.total ?? 0;
        if (total === 0) {
          return (
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              —
            </span>
          );
        }
        const nonPending = total - (inv?.pending ?? 0);
        return (
          <span
            style={{
              display: "inline-flex",
              flexDirection: "column",
              gap: "2px",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{total} invited</span>
            <span style={{ color: "var(--aiq-color-fg-muted)" }}>
              {nonPending} sent · {inv?.pending ?? 0} pending
            </span>
          </span>
        );
      },
    },
    {
      key: "opens_at",
      label: "Opens",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.opens_at ? new Date(row.opens_at).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      key: "closes_at",
      label: "Closes",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {row.closes_at ? new Date(row.closes_at).toLocaleDateString() : "—"}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      render: (row: AssessmentListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {new Date(row.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 80,
      render: (row: AssessmentListItem) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-outline aiq-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/admin/assessments/${row.id}`);
          }}
        >
          Open
        </button>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Assessments"]} helpPage="admin.assessments.list">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Header row */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--aiq-space-md)",
          }}
        >
          <h1
            style={{
              fontFamily: "var(--aiq-font-serif)",
              fontSize: "var(--aiq-text-3xl)",
              fontWeight: 400,
              margin: 0,
              letterSpacing: "-0.02em",
            }}
          >
            Assessments.
          </h1>
          <button
            type="button"
            className="aiq-btn aiq-btn-primary"
            onClick={() => {
              setShowNewForm((v) => !v);
              setCreateError(null);
            }}
          >
            {showNewForm ? "Cancel" : "+ New Assessment"}
          </button>
        </div>

        {/* Inline new-assessment form */}
        {showNewForm && (
          <div
            style={{
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              padding: "var(--aiq-space-lg)",
              background: "var(--aiq-color-bg-raised)",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-md)",
                letterSpacing: "-0.015em",
              }}
            >
              New assessment.
            </h2>
            <form onSubmit={(e) => void handleCreateAssessment(e)}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--aiq-space-md)",
                  marginBottom: "var(--aiq-space-md)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Name *
                  </label>
                  <input
                    className="aiq-input"
                    type="text"
                    placeholder="e.g. SOC L1 — May 2026"
                    value={newForm.name}
                    onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Pack ID{" "}
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        color: "var(--aiq-color-fg-muted)",
                        fontSize: "var(--aiq-text-xs)",
                      }}
                    >
                      (optional — paste from Question Bank)
                    </span>
                  </label>
                  <input
                    className="aiq-input"
                    type="text"
                    placeholder="Paste pack UUID"
                    value={newForm.pack_id}
                    onChange={(e) => setNewForm((f) => ({ ...f, pack_id: e.target.value }))}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Opens
                  </label>
                  <input
                    className="aiq-input"
                    type="datetime-local"
                    value={newForm.opens_at}
                    onChange={(e) => setNewForm((f) => ({ ...f, opens_at: e.target.value }))}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--aiq-space-xs)",
                  }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Closes
                  </label>
                  <input
                    className="aiq-input"
                    type="datetime-local"
                    value={newForm.closes_at}
                    onChange={(e) => setNewForm((f) => ({ ...f, closes_at: e.target.value }))}
                  />
                </div>
              </div>
              {createError && (
                <div
                  style={{
                    color: "var(--aiq-color-danger)",
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    marginBottom: "var(--aiq-space-sm)",
                  }}
                >
                  {createError}
                </div>
              )}
              <button type="submit" className="aiq-btn aiq-btn-primary" disabled={creating}>
                {creating ? "Creating…" : "Create assessment"}
              </button>
            </form>
          </div>
        )}

        {/* Filter chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`aiq-btn aiq-btn-sm ${
                statusFilter === tab.value ? "aiq-btn-primary" : "aiq-btn-outline"
              }`}
              onClick={() => handleStatusChange(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
              color: "var(--aiq-color-danger)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div
            style={{
              color: "var(--aiq-color-fg-muted)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              padding: "var(--aiq-space-xl) 0",
            }}
          >
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--aiq-space-3xl) 0",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            <p
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-sm)",
              }}
            >
              No assessments yet.
            </p>
            <p
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                margin: 0,
              }}
            >
              Create an assessment to invite candidates and open a cycle.
            </p>
          </div>
        ) : (
          <Table
            columns={columns}
            data={items}
            emptyMessage="No assessments found."
          />
        )}
      </div>
    </AdminShell>
  );
}
