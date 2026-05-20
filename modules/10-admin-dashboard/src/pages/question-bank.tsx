// AssessIQ — Admin Question Bank list page.
//
// /admin/question-bank — list of question packs in the current tenant.
//
// Filter state: URL query params (?status=draft&search=foo) per CLAUDE.md
// anti-pattern guard (no localStorage / sessionStorage for filter state).
// Shares a route prefix with the existing /admin/question-bank/questions/:id
// (question editor, shipped G2.C). React Router v6 matches the literal
// "questions" segment before the ":id" param, so no collision.
//
// "+ New Pack" opens an inline form (no separate /new route — consistent
// with pack-detail.tsx add-level pattern; fewer route hops for the admin).
//
// INVARIANTS:
//  - No claude/anthropic imports or copy.
//  - Filter state in URL query params only.
//  - Empty-state renders; no hardcoded fake rows.

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

type PackStatus = "draft" | "published" | "archived";

interface PackListItem {
  id: string;
  name: string;
  slug: string;
  domain: string;
  status: PackStatus;
  version: number;
  question_count: number;
  created_at: string;
  updated_at: string;
}

interface PacksResponse {
  items: PackListItem[];
  total: number;
}

const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Archived", value: "archived" },
];

function packStatusColor(s: string): { bg: string; color: string } {
  switch (s) {
    case "published":
      return { bg: "var(--aiq-color-success-soft)", color: "var(--aiq-color-success)" };
    case "archived":
      return { bg: "var(--aiq-color-bg-sunken)", color: "var(--aiq-color-fg-muted)" };
    default:
      return { bg: "var(--aiq-color-accent-soft)", color: "var(--aiq-color-accent)" };
  }
}

interface NewPackForm {
  name: string;
  domain: string;
  description: string;
}

export function AdminQuestionBank(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const searchQuery = searchParams.get("search") ?? "";

  const [items, setItems] = useState<PackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewPackForm>({ name: "", domain: "", description: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState(searchQuery);

  const [archivingPackId, setArchivingPackId] = useState<string | null>(null);

  const fetchPacks = useCallback(async (status: string, search: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (status) qs.set("status", status);
      if (search) qs.set("search", search);
      const data = await adminApi<PacksResponse>(`/admin/packs?${qs.toString()}`);
      setItems(data.items);
    } catch (err) {
      setError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to load question packs.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPacks(statusFilter, searchQuery);
  }, [fetchPacks, statusFilter, searchQuery]);

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

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (searchInput.trim()) next.set("search", searchInput.trim());
        else next.delete("search");
        return next;
      },
      { replace: true },
    );
  }

  async function handleArchivePack(pack: PackListItem) {
    if (!window.confirm(`Are you sure? This will archive "${pack.name}".`)) return;
    setArchivingPackId(pack.id);
    try {
      await adminApi(`/admin/packs/${pack.id}/archive`, { method: "POST" });
      await fetchPacks(statusFilter, searchQuery);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("archive-pack error:", err instanceof AdminApiError ? err.apiError.message : err);
    } finally {
      setArchivingPackId(null);
    }
  }

  async function handleCreatePack(e: React.FormEvent) {    e.preventDefault();
    if (!newForm.name.trim()) { setCreateError("Pack name is required."); return; }
    if (!newForm.domain.trim()) { setCreateError("Domain is required."); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await adminApi<{ id: string }>("/admin/packs", {
        method: "POST",
        body: JSON.stringify({
          name: newForm.name.trim(),
          domain: newForm.domain.trim(),
          description: newForm.description.trim() || undefined,
        }),
      });
      navigate(`/admin/question-bank/${created.id}`);
    } catch (err) {
      setCreateError(
        err instanceof AdminApiError ? err.apiError.message : "Failed to create pack.",
      );
      setCreating(false);
    }
  }

  const columns: ColumnDef<PackListItem>[] = [
    {
      key: "name",
      label: "Name",
      render: (row: PackListItem) => (
        <div>
          <span
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontWeight: 500,
              fontSize: "var(--aiq-text-sm)",
              display: "block",
            }}
          >
            {row.name}
          </span>
          <span
            style={{
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "var(--aiq-text-xs)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            {row.slug}
          </span>
        </div>
      ),
    },
    {
      key: "domain",
      label: "Domain",
      render: (row: PackListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {row.domain}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row: PackListItem) => {
        const c = packStatusColor(row.status);
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
      key: "question_count",
      label: "Questions",
      render: (row: PackListItem) => (
        <span
          className="num"
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-sm)",
            fontVariantNumeric: "lining-nums tabular-nums",
          }}
        >
          {row.question_count}
        </span>
      ),
    },
    {
      key: "version",
      label: "Version",
      render: (row: PackListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          v{row.version}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      render: (row: PackListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {new Date(row.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 140,
      render: (row: PackListItem) => (
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
          {row.status !== "archived" && (
            <button
              type="button"
              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
              disabled={archivingPackId === row.id}
              onClick={(e) => {
                e.stopPropagation();
                void handleArchivePack(row);
              }}
              style={{ color: "var(--aiq-color-danger)" }}
            >
              {archivingPackId === row.id ? "…" : "Archive"}
            </button>
          )}
          <button
            type="button"
            className="aiq-btn aiq-btn-outline aiq-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/admin/question-bank/${row.id}`);
            }}
          >
            Open
          </button>
        </div>
      ),
    },
  ];

  return (
    <AdminShell breadcrumbs={["Question Bank"]} helpPage="admin.question_bank.list">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede + action */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{items.length} pack{items.length !== 1 ? "s" : ""}</Chip>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "var(--aiq-space-md)",
            }}
          >
            <div>
              <h1
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-3xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.02em",
                }}
              >
                Question Bank.
              </h1>
              <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
                Question packs organised by domain and difficulty level.
              </p>
            </div>
            <button
              type="button"
              className="aiq-btn aiq-btn-primary"
              onClick={() => {
                setShowNewForm((v) => !v);
                setCreateError(null);
              }}
            >
              {showNewForm ? "Cancel" : "+ New Pack"}
            </button>
          </div>
        </div>

        {/* Inline new-pack form */}
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
              New question pack.
            </h2>
            <form onSubmit={(e) => void handleCreatePack(e)}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--aiq-space-md)",
                  marginBottom: "var(--aiq-space-md)",
                }}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Pack name *
                  </label>
                  <input
                    className="aiq-input"
                    type="text"
                    placeholder="e.g. SOC Analyst L1–L3"
                    value={newForm.name}
                    onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}
                >
                  <label
                    style={{
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-sm)",
                      fontWeight: 500,
                    }}
                  >
                    Domain *
                  </label>
                  <input
                    data-help-id="admin.packs.create.domain"
                    className="aiq-input"
                    type="text"
                    placeholder="e.g. soc"
                    value={newForm.domain}
                    onChange={(e) => setNewForm((f) => ({ ...f, domain: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--aiq-space-xs)",
                  marginBottom: "var(--aiq-space-md)",
                }}
              >
                <label
                  style={{
                    fontFamily: "var(--aiq-font-sans)",
                    fontSize: "var(--aiq-text-sm)",
                    fontWeight: 500,
                  }}
                >
                  Description
                </label>
                <textarea
                  className="aiq-input"
                  rows={2}
                  placeholder="Optional description"
                  value={newForm.description}
                  onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
                  style={{ resize: "vertical" }}
                />
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
                {creating ? "Creating…" : "Create pack"}
              </button>
            </form>
          </div>
        )}

        {/* Search + filter row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--aiq-space-md)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
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
          <form
            onSubmit={handleSearchSubmit}
            style={{ display: "flex", gap: "var(--aiq-space-xs)" }}
          >
            <input
              className="aiq-input"
              type="search"
              placeholder="Search packs…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <button type="submit" className="aiq-btn aiq-btn-outline aiq-btn-sm">
              Search
            </button>
          </form>
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
              No question packs yet.
            </p>
            <p
              style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", margin: 0 }}
            >
              Create your first pack to get started.
            </p>
          </div>
        ) : (
        <Table
            columns={columns}
            data={items}
            emptyMessage="No question packs found."
          />
        )}
      </div>
    </AdminShell>
  );
}
