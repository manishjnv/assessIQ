// AssessIQ — Admin audit trail page (FU-B2).
//
// Backed by GET /api/admin/audit (paginated, filterable) and
// GET /api/admin/audit/export.csv (module 14). The brief named a POST
// /admin/audit-log route; the live backend is the GET pair above, so this page
// uses it. Route registration is NOT done here (FE routing follows).
//
// INVARIANTS: no claude/anthropic imports; loading spinner + inline error.

import React, { useCallback, useEffect, useState } from "react";
import { Button, Input, Spinner, formatDateTime } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { adminApi } from "../api.js";

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
interface AuditList { rows: AuditRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 50;
// Visible filter labels use the glossary; values are the API entity_type strings.
const ENTITY_TYPES: Array<[string, string]> = [
  ["", "All entities"],
  ["assessment", "Assessment"],
  ["attempt", "Attempt"],
  ["user", "User"],
  ["tenant", "Organisation"],
  ["pack", "Question set"],
];

const th: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", borderBottom: "1px solid var(--aiq-color-border)" };
const td: React.CSSProperties = { padding: "10px 12px", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", borderBottom: "1px solid var(--aiq-color-border)", verticalAlign: "top" };

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

  const csvHref = `/api/admin/audit/export.csv?${filterQuery(from, to, entityType).toString()}`;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <AdminShell breadcrumbs={["Admin", "Audit log"]}>
      <div data-help-id="admin.audit-log.page" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <PageHeader
          eyebrow="Audit log"
          title="Audit log."
          lede="Every change made in your organisation, with who made it and when."
          actions={<a className="aiq-btn aiq-btn-outline aiq-btn-sm" href={csvHref} download>Export CSV</a>}
        />

        <div data-help-id="admin.audit-log.filters" style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", alignItems: "center" }}>
          <Input type="date" aria-label="From date" data-help-id="admin.audit-log.date-from" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} style={{ width: 160 }} />
          <Input type="date" aria-label="To date" data-help-id="admin.audit-log.date-to" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} style={{ width: 160 }} />
          <select className="aiq-input" aria-label="Entity type" data-help-id="admin.audit-log.entity-type" value={entityType} onChange={(e) => { setPage(1); setEntityType(e.target.value); }} style={{ width: 180 }}>
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
            <div data-help-id="admin.audit-log.table" style={{ overflowX: "auto", border: "1px solid var(--aiq-color-border)", borderRadius: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr><th style={th}>Timestamp</th><th style={th}>Entity</th><th style={th}>Action</th><th style={th}>User</th><th style={th}>Details</th></tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td style={td} colSpan={5}>No events match these filters.</td></tr>}
                  {data.rows.map((r) => {
                    const details = r.after ? JSON.stringify(r.after) : "";
                    return (
                      <tr key={r.id}>
                        <td style={{ ...td, fontFamily: "var(--aiq-font-mono)", whiteSpace: "nowrap" }}>{formatDateTime(r.at)}</td>
                        <td style={td}>{r.entity_type}{r.entity_id && <span style={{ fontFamily: "var(--aiq-font-mono)", color: "var(--aiq-color-fg-muted)" }}> {r.entity_id.slice(0, 8)}</span>}</td>
                        <td style={td}>{r.action}</td>
                        {/* API returns the actor id, not an email; show short id or actor kind. */}
                        <td style={{ ...td, fontFamily: "var(--aiq-font-mono)" }}>{r.actor_user_id ? r.actor_user_id.slice(0, 8) : r.actor_kind}</td>
                        <td style={{ ...td, fontFamily: "var(--aiq-font-mono)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={details}>{details || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
