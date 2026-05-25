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

import React, { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Chip, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, listDomainsApi, getAvailableSets, importLicensedSet, resyncLicensedSet } from "../api.js";
import type { DomainItem, AvailableSet } from "../api.js";
import { useAdminSession } from "../session.js";
import { formatDate } from "../lib/format.js";
import { domainLabel } from "../lib/domains.js";
import { packStatusDisplay } from "../lib/status.js";

type PackStatus = "draft" | "published" | "archived";

interface PackListItem {
  id: string;
  name: string;
  slug: string;
  domain: string;
  status: PackStatus;
  version: number;
  question_count: number;
  /** Number of levels (L1/L2/L3) defined in this pack. */
  level_count: number;
  /** Times candidates in this tenant finished an assessment built on this pack. */
  completed_count: number;
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

interface NewPackForm {
  name: string;
  domain: string;
  description: string;
}

type SortDir = "asc" | "desc";

/**
 * Client-side sort for the packs grid. The list is fetched whole (pageSize 100)
 * so sorting happens in the browser — no extra API round-trip. `created_at`
 * sorts as a date; numeric columns numerically; everything else as a
 * case-insensitive string. domain sorts on the raw slug, not the display label.
 */
function sortPacks(rows: PackListItem[], key: string, dir: SortDir): PackListItem[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "created_at") {
      return sign * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (typeof av === "number" && typeof bv === "number") {
      return sign * (av - bv);
    }
    const as = String(av ?? "").toLowerCase();
    const bs = String(bv ?? "").toLowerCase();
    if (as < bs) return -1 * sign;
    if (as > bs) return 1 * sign;
    return 0;
  });
}

// Row-level overflow menu. The dropdown is rendered to document.body via
// createPortal and anchored with getBoundingClientRect (position:fixed) — the
// packs table uses overflow:hidden for its rounded corners, which would clip a
// plainly-absolute dropdown (the menu silently never appeared). Same pattern as
// platform.tsx's ManageMenu. Closes on outside click / Esc / scroll / resize.
interface RowOverflowMenuProps {
  busy?: boolean;
  onArchive: () => void;
}

function RowOverflowMenu({ busy, onArchive }: RowOverflowMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    if (triggerRef.current === null) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });

    function close() {
      setOpen(false);
    }
    function onDocClick(e: MouseEvent) {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="aiq-btn aiq-btn-ghost aiq-btn-sm"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{ padding: "4px 8px", fontSize: 16, lineHeight: 1 }}
      >
        {busy ? "…" : "⋯"}
      </button>
      {open && coords !== null &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            style={{
              position: "fixed",
              top: coords.top,
              right: coords.right,
              zIndex: 1000,
              minWidth: 160,
              background: "var(--aiq-color-bg-base)",
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-md)",
              boxShadow: "var(--aiq-shadow-lg)",
              padding: 4,
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onArchive();
              }}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                color: "var(--aiq-color-danger)",
              }}
            >
              Archive…
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

export function AdminQuestionBank(): React.ReactElement {
  const navigate = useNavigate();
  const { session } = useAdminSession();
  const isSuperAdmin = session?.user.role === "super_admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get("status") ?? "";
  const searchQuery = searchParams.get("search") ?? "";

  // Default the list to Published on first visit (live content first). Ref-guarded
  // so it runs exactly once — after this, clicking "All" (which clears the param)
  // is respected and never bounced back to Published.
  const didDefaultStatus = useRef(false);
  useEffect(() => {
    if (didDefaultStatus.current) return;
    didDefaultStatus.current = true;
    if (!searchParams.has("status")) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("status", "published");
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  // Sort state — client-side over the loaded page. Defaults to the server's
  // own order (created_at desc) so first paint is unchanged.
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [items, setItems] = useState<PackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewPackForm>({ name: "", domain: "", description: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [domains, setDomains] = useState<DomainItem[]>([]);

  const [searchInput, setSearchInput] = useState(searchQuery);

  const [archivingPackId, setArchivingPackId] = useState<string | null>(null);
  // Surfaces failures from row actions (archive / import) that would otherwise
  // be invisible — a swallowed 409 reads to the admin as "archive does nothing".
  const [actionError, setActionError] = useState<string | null>(null);

  const [licensedSets, setLicensedSets] = useState<AvailableSet[]>([]);
  const [importingSet, setImportingSet] = useState<string | null>(null);
  const [resyncingSet, setResyncingSet] = useState<string | null>(null);

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
    setActionError(null);
    try {
      await adminApi(`/admin/packs/${pack.id}/archive`, { method: "POST" });
      await fetchPacks(statusFilter, searchQuery);
    } catch (err) {
      setActionError(
        err instanceof AdminApiError
          ? `Could not archive "${pack.name}": ${err.apiError.message}`
          : `Could not archive "${pack.name}".`,
      );
    } finally {
      setArchivingPackId(null);
    }
  }

  async function handleImportSet(sourcePackId: string) {
    setImportingSet(sourcePackId);
    setActionError(null);
    try {
      await importLicensedSet(sourcePackId);
      // Refresh the licensed-sets catalog (cloned flag flips) and the packs list (new pack appears).
      const fresh = await getAvailableSets();
      setLicensedSets(fresh.sets);
      await fetchPacks(statusFilter, searchQuery);
    } catch (err) {
      setActionError(
        err instanceof AdminApiError
          ? `Could not add set to workspace: ${err.apiError.message}`
          : "Could not add set to workspace.",
      );
    } finally {
      setImportingSet(null);
    }
  }

  async function handleResyncSet(sourcePackId: string) {
    setResyncingSet(sourcePackId);
    setActionError(null);
    try {
      await resyncLicensedSet(sourcePackId);
      // Refresh the licensed-sets catalog (update_available flag may clear) and the packs list.
      const fresh = await getAvailableSets();
      setLicensedSets(fresh.sets);
      await fetchPacks(statusFilter, searchQuery);
    } catch (err) {
      setActionError(
        err instanceof AdminApiError
          ? `Could not update set: ${err.apiError.message}`
          : "Could not update set.",
      );
    } finally {
      setResyncingSet(null);
    }
  }

  // Domains for the New-Pack dropdown. Canonical source is the domains table
  // (the same /admin/domains the Generate + Blueprint dropdowns use), so new
  // packs always carry a valid lowercase slug — no free-text casing drift.
  // Only fetched for super_admin, the sole role that can create packs.
  useEffect(() => {
    if (!isSuperAdmin) return;
    listDomainsApi()
      .then((res) => setDomains(res.items))
      .catch(() => { /* non-critical — the field will show no options */ });
  }, [isSuperAdmin]);

  // Licensed sets — platform-library sets this tenant is licensed for.
  // Returns empty for super_admin (platform owns the library) — section hidden.
  useEffect(() => {
    getAvailableSets()
      .then((res) => setLicensedSets(res.sets))
      .catch(() => { /* non-critical */ });
  }, []);

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
      sortable: true,
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
      sortable: true,
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
          {domainLabel(row.domain)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      render: (row: PackListItem) => {
        const s = packStatusDisplay(row.status);
        return <Chip variant={s.variant}>{s.label}</Chip>;
      },
    },
    {
      key: "level_count",
      label: "Levels",
      sortable: true,
      render: (row: PackListItem) => (
        <span
          className="num"
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-sm)",
            fontVariantNumeric: "lining-nums tabular-nums",
            color: row.level_count === 0 ? "var(--aiq-color-fg-muted)" : undefined,
          }}
        >
          {row.level_count}
        </span>
      ),
    },
    {
      key: "question_count",
      label: "Questions",
      sortable: true,
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
      key: "completed_count",
      label: "Completed",
      sortable: true,
      render: (row: PackListItem) => (
        <span
          className="num"
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-sm)",
            fontVariantNumeric: "lining-nums tabular-nums",
          }}
        >
          {row.completed_count}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      sortable: true,
      render: (row: PackListItem) => (
        <span
          style={{
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
          }}
        >
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: "action",
      label: "",
      width: 140,
      render: (row: PackListItem) => (
        <div
          style={{
            display: "flex",
            gap: "var(--aiq-space-xs)",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="aiq-btn aiq-btn-ghost aiq-btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/admin/question-bank/${row.id}`);
            }}
          >
            View →
          </button>
          {isSuperAdmin && row.status !== "archived" && (
            <RowOverflowMenu
              busy={archivingPackId === row.id}
              onArchive={() => void handleArchivePack(row)}
            />
          )}
        </div>
      ),
    },
  ];

  const sortedItems = React.useMemo(
    () => sortPacks(items, sortBy, sortDir),
    [items, sortBy, sortDir],
  );

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
            {isSuperAdmin && (
              <HelpTip helpId="admin.question_bank.list.new_pack">
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
              </HelpTip>
            )}
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
                  <select
                    data-help-id="admin.packs.create.domain"
                    className="aiq-input"
                    value={newForm.domain}
                    onChange={(e) => setNewForm((f) => ({ ...f, domain: e.target.value }))}
                    required
                  >
                    <option value="">— Select a domain —</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.slug}>
                        {d.name}
                      </option>
                    ))}
                  </select>
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

        {/* Licensed sets — read-only, only shown when tenant has licensed sets */}
        {licensedSets.length > 0 && (
          <div style={{ marginBottom: "var(--aiq-space-lg)" }}>
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-xl)",
                fontWeight: 400,
                margin: "0 0 var(--aiq-space-xs)",
                letterSpacing: "-0.015em",
              }}
            >
              Licensed sets.
            </h2>
            <p
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-fg-muted)",
                margin: "0 0 var(--aiq-space-md)",
              }}
            >
              Question sets your company is licensed for. Add one to your workspace from the Assessments page (&ldquo;From a set&rdquo;).
            </p>
            <div
              style={{
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-md)",
                overflow: "hidden",
              }}
            >
              {licensedSets.map((set, idx) => (
                <div
                  key={set.source_pack_id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--aiq-space-md)",
                    padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                    borderTop: idx === 0 ? undefined : "1px solid var(--aiq-color-border)",
                    background: "var(--aiq-color-bg-raised)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontWeight: 500,
                        fontSize: "var(--aiq-text-sm)",
                        display: "block",
                      }}
                    >
                      {set.name}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: "var(--aiq-text-xs)",
                        color: "var(--aiq-color-fg-muted)",
                      }}
                    >
                      {domainLabel(set.domain)} &middot; {set.level_count} level{set.level_count !== 1 ? "s" : ""} &middot; {set.question_count} question{set.question_count !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "var(--aiq-space-xs)", flexShrink: 0, alignItems: "center" }}>
                    {set.cloned && <Chip leftIcon="check">In your workspace</Chip>}
                    {set.update_available && <Chip>Update available</Chip>}
                    {set.cloned && set.update_available && (
                      <button
                        type="button"
                        className="aiq-btn aiq-btn-outline aiq-btn-sm"
                        disabled={resyncingSet === set.source_pack_id}
                        onClick={() => void handleResyncSet(set.source_pack_id)}
                      >
                        {resyncingSet === set.source_pack_id ? "Updating…" : "Update"}
                      </button>
                    )}
                    {!set.cloned && (
                      <HelpTip helpId="admin.question_bank.list.add_to_workspace">
                        <button
                          type="button"
                          className="aiq-btn aiq-btn-outline aiq-btn-sm"
                          disabled={importingSet === set.source_pack_id}
                          onClick={() => void handleImportSet(set.source_pack_id)}
                        >
                          {importingSet === set.source_pack_id ? "Adding…" : "Add to workspace"}
                        </button>
                      </HelpTip>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filter row — quiet ghost tabs, search, right-aligned results count */}
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
          <div style={{ display: "flex", gap: "var(--aiq-space-2xs)" }}>
            {STATUS_TABS.map((tab) => {
              const isActive = statusFilter === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => handleStatusChange(tab.value)}
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
          <form
            onSubmit={handleSearchSubmit}
            style={{ display: "flex", gap: "var(--aiq-space-xs)" }}
          >
            <input
              className="aiq-input"
              type="search"
              placeholder="Search packs…"
              value={searchInput}
              onChange={(e) => {
                const v = e.target.value;
                setSearchInput(v);
                // Emptying the box (incl. the native search "×") restores the
                // full list immediately — submit is only needed to APPLY a term,
                // not to clear one. Without this, the stale `search` URL param
                // kept filtering the list after the text was gone.
                if (v.trim() === "" && searchQuery !== "") {
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev);
                      next.delete("search");
                      return next;
                    },
                    { replace: true },
                  );
                }
              }}
              style={{ minWidth: 200 }}
            />
            <button type="submit" className="aiq-btn aiq-btn-outline aiq-btn-sm">
              Search
            </button>
          </form>
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

        {actionError && (
          <div
            role="alert"
            style={{
              color: "var(--aiq-color-danger)",
              background: "var(--aiq-color-danger-soft, transparent)",
              border: "1px solid var(--aiq-color-danger)",
              borderRadius: "var(--aiq-radius-md)",
              padding: "var(--aiq-space-sm) var(--aiq-space-md)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--aiq-space-md)",
            }}
          >
            <span>{actionError}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="aiq-btn aiq-btn-ghost aiq-btn-sm"
              onClick={() => setActionError(null)}
              style={{ color: "inherit" }}
            >
              ✕
            </button>
          </div>
        )}

        <div
          className="aiq-card"
          data-density="compact"
          style={{ padding: 0, overflow: "hidden" }}
        >
          <div className="aiq-admin-table-scroll">
            {!loading && items.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "var(--aiq-space-3xl) var(--aiq-space-lg)",
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--aiq-font-serif)",
                    fontSize: "var(--aiq-text-xl)",
                    fontWeight: 400,
                    margin: "0 0 var(--aiq-space-sm)",
                    letterSpacing: "-0.015em",
                  }}
                >
                  {statusFilter || searchQuery ? "No packs match this filter." : "No question packs yet."}
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
                  {statusFilter || searchQuery
                    ? "Try a different filter, or clear search to see all packs."
                    : "Create your first pack to get started."}
                </p>
              </div>
            ) : (
              <Table
                columns={columns}
                data={sortedItems}
                loading={loading}
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={(key, dir) => {
                  setSortBy(key);
                  setSortDir(dir);
                }}
                emptyMessage="No question packs found."
              />
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
