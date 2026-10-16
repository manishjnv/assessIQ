// AssessIQ — Admin audit trail page (FU-B2).
//
// Backed by GET /api/admin/audit (paginated, filterable) and
// GET /api/admin/audit/export.csv (module 14). The brief named a POST
// /admin/audit-log route; the live backend is the GET pair above, so this page
// uses it. Route registration is NOT done here (FE routing follows).
//
// INVARIANTS: no claude/anthropic imports; loading spinner + inline error.

import React, { useCallback, useEffect, useState } from "react";
import { Button, ConfirmDialog, Input, Spinner, Table, formatDateTime } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { adminApi } from "../api.js";
import { shortId } from "../lib/labels.js";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  after: Record<string, unknown> | null;
  at: string;
}
interface ArchiveResult { archive_id: string | null; row_count: number; truncated: boolean; export_url: string }
interface AuditList { rows: AuditRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 50;
const EXPORT_CAP = 100000; // matches the API export row cap (module 14, FR1)
// Visible filter labels use the glossary; values are the API entity_type strings.
const ENTITY_TYPES: Array<[string, string]> = [
  ["", "All entities"],
  ["assessment", "Assessment"],
  ["attempt", "Attempt"],
  ["user", "User"],
  ["tenant", "Organisation"],
  ["pack", "Question set"],
];


// ponytail: date-only inputs; `to` is made inclusive by pushing to end of day.
function filterQuery(from: string, to: string, entityType: string): URLSearchParams {
  const p = new URLSearchParams();
  if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString());
  if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString());
  if (entityType) p.set("entityType", entityType);
  return p;
}

export default function AuditLogPage(): React.ReactElement {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archived, setArchived] = useState<ArchiveResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = filterQuery(from, to, entityType);
      q.set("page", String(page));
      q.set("pageSize", String(PAGE_SIZE));
      setData(await adminApi<AuditList>(`/admin/audit?${q.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the audit log.");
    } finally {
      setLoading(false);
    }
  }, [from, to, entityType, page]);

  useEffect(() => { void load(); }, [load]);

  const archive = async () => {
    setArchiving(true);
    setArchiveError(null);
    try {
      const q = filterQuery(from, to, "");
      const res = await adminApi<ArchiveResult>("/admin/audit/archive", {
        method: "POST",
        body: JSON.stringify({ from: q.get("from"), to: q.get("to"), format: "jsonl" }),
      });
      setArchived(res);
      setConfirmOpen(false);
      const a = document.createElement("a"); // download the range that was just marked
      a.href = res.export_url;
      a.download = "";
      a.click();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : "Could not archive this range.");
    } finally {
      setArchiving(false);
    }
  };

  const csvHref = `/api/admin/audit/export.csv?${filterQuery(from, to, entityType).toString()}`;
  const jsonlHref = `/api/admin/audit/export.jsonl?${filterQuery(from, to, entityType).toString()}`;
  const overCap = (archived !== null && (archived.truncated || archived.row_count >= EXPORT_CAP)) || (data?.total ?? 0) > EXPORT_CAP;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <AdminShell breadcrumbs={["Admin", "Audit log"]} helpPage="admin.audit">
      <div data-help-id="admin.audit.page" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <PageHeader
          eyebrow="Audit log"
          title="Audit log."
          lede="Every change made in your organisation, with who made it and when."
          actions={
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
              <a className="aiq-btn aiq-btn-outline aiq-btn-sm" href={csvHref} download>Export CSV</a>
              <a className="aiq-btn aiq-btn-outline aiq-btn-sm" data-help-id="admin.audit.export_jsonl" href={jsonlHref} download>Export JSONL</a>
              <Button variant="outline" size="sm" data-help-id="admin.audit.archive" disabled={!from || !to} onClick={() => { setArchiveError(null); setConfirmOpen(true); }}>Archive range</Button>
            </div>
          }
        />
        <div style={{ fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
          Archiving marks the range in the audit trail and downloads it. Rows are never deleted.
        </div>
        {archived && <div role="status" style={{ fontSize: "var(--aiq-text-sm)" }}>{archived.row_count} rows marked as archived</div>}
        {overCap && (
          <div data-help-id="admin.audit.truncated_note" role="note" style={{ fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
            The export covers the first 100,000 rows. Narrow the date range and export again.
          </div>
        )}
        <ConfirmDialog
          open={confirmOpen}
          title="Archive this range?"
          confirmLabel={archiving ? "Archiving…" : "Archive and download"}
          busy={archiving}
          onConfirm={() => { void archive(); }}
          onCancel={() => { if (!archiving) setConfirmOpen(false); }}
          body={
            <>
              <div>From {from} to {to}. This marks the range in the audit trail and downloads it. Rows are never deleted.</div>
              {archiveError && <div role="alert" style={{ marginTop: "var(--aiq-space-sm)", color: "var(--aiq-color-danger)" }}>{archiveError}</div>}
            </>
          }
        />

        <div data-help-id="admin.audit.filters" style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", alignItems: "center" }}>
          <Input type="date" aria-label="From date" data-help-id="admin.audit.date_from" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} style={{ width: 160 }} />
          <Input type="date" aria-label="To date" data-help-id="admin.audit.date_to" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} style={{ width: 160 }} />
          <select className="aiq-input" aria-label="Entity type" data-help-id="admin.audit.entity_type" value={entityType} onChange={(e) => { setPage(1); setEntityType(e.target.value); }} style={{ width: 180 }}>
            {ENTITY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {(from || to || entityType) && (
            <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); setEntityType(""); setPage(1); }}>Clear</Button>
          )}
        </div>

        {loading && <Spinner />}
        {error && <div role="alert" style={{ color: "var(--aiq-color-danger)", fontSize: "var(--aiq-text-sm)" }}>{error}</div>}
        {!loading && !error && data && (
          <>
            <div data-help-id="admin.audit.table" style={{ overflowX: "auto", border: "1px solid var(--aiq-color-border)", borderRadius: 16 }}>
              <Table<AuditRow>
                data={data.rows}
                emptyMessage="No events match these filters."
                columns={[
                  { key: "at", label: "Timestamp", width: "minmax(160px, 1fr)", render: (r) => <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)" }}>{formatDateTime(r.at)}</span> },
                  { key: "entity", label: "Entity", render: (r) => <span>{r.entity_type}{r.entity_id && <span style={{ fontFamily: "var(--aiq-font-mono)", color: "var(--aiq-color-fg-muted)" }}> {shortId(r.entity_id)}</span>}</span> },
                  { key: "action", label: "Action", render: (r) => r.action },
                  // API returns the actor id, not an email; show short id or actor kind.
                  { key: "user", label: "User", render: (r) => <span style={{ fontFamily: "var(--aiq-font-mono)" }}>{r.actor_user_id ? shortId(r.actor_user_id) : r.actor_kind}</span> },
                  { key: "details", label: "Details", width: "minmax(0, 2fr)", render: (r) => { const details = r.after ? JSON.stringify(r.after) : ""; return <span title={details} style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{details || "—"}</span>; } },
                ]}
              />
            </div>
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", fontSize: "var(--aiq-text-sm)" }}>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span>Page {page} of {pages} ({data.total} events)</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}
