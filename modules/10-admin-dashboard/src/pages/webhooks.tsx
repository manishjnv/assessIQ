// AssessIQ — Admin webhooks page (FU-B7).
//
// Live backend (module 13): GET/POST /admin/webhooks, DELETE /admin/webhooks/:id,
// POST /admin/webhooks/:id/test, GET /admin/webhooks/deliveries. The brief named
// GET /admin/integrations/webhooks; that path does not exist, so the real ones are used.
// The signing secret is returned ONCE at create — there is no "copy existing secret";
// the copy button appears on the just-created endpoint only.
//
// INVARIANTS: no claude/anthropic imports; per-section loading + inline error.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, Chip, Input, Spinner, Table, formatDateTime } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { adminApi } from "../api.js";

interface Endpoint { id: string; name: string; url: string; events: string[]; status: "active" | "disabled" }
interface Delivery { id: string; endpoint_id: string; event: string; status: "pending" | "delivered" | "failed"; http_status: number | null; attempts: number; last_error: string | null; created_at: string; payload?: { attemptId?: string; attempt_id?: string } | null }

const DELIVERY_PAGE = 20;
const mono: React.CSSProperties = { fontFamily: "var(--aiq-font-mono)" };
const deliveryColumns: ColumnDef<Delivery>[] = [
  { key: "created_at", label: "Timestamp", render: (d) => <span style={{ ...mono, whiteSpace: "nowrap" }}>{formatDateTime(d.created_at)}</span> },
  { key: "status", label: "Status", render: (d) => <Chip variant={d.status === "delivered" ? "success" : d.status === "failed" ? "warn" : "default"}>{d.status === "delivered" ? "Success" : d.status === "failed" ? "Failed" : "Pending"}</Chip> },
  { key: "attempt", label: "Attempt ID", render: (d) => <span style={mono}>{d.payload?.attemptId ?? d.payload?.attempt_id ?? "—"}</span> },
  { key: "response", label: "Response", render: (d) => <span style={mono}>{d.http_status ?? "—"}{d.last_error ? ` ${d.last_error.slice(0, 60)}` : ""}</span> },
];
const err = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");

function toCsv(rows: Delivery[]): string {
  const q = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [["timestamp", "event", "status", "http_status", "attempts", "error"].join(","),
    ...rows.map((d) => [d.created_at, d.event, d.status, d.http_status, d.attempts, d.last_error].map(q).join(","))].join("\n");
}

export default function WebhooksPage(): React.ReactElement {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [epError, setEpError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", events: "attempt.graded" });
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(() => {
    adminApi<{ items: Endpoint[] }>("/admin/webhooks").then((r) => setEndpoints(r.items)).catch((e) => setEpError(err(e)));
    adminApi<{ items: Delivery[] }>("/admin/webhooks/deliveries").then((r) => setDeliveries(r.items)).catch((e) => setDlError(err(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setNotice(null);
    try {
      const r = await adminApi<{ endpoint: Endpoint; secret: string }>("/admin/webhooks", {
        method: "POST",
        body: JSON.stringify({ name: form.name.trim(), url: form.url.trim(), events: form.events.split(",").map((s) => s.trim()).filter(Boolean) }),
      });
      setSecret({ id: r.endpoint.id, value: r.secret });
      setAdding(false);
      setForm({ name: "", url: "", events: "attempt.graded" });
      load();
    } catch (e) { setNotice(err(e)); }
  }
  async function test(id: string) {
    try { await adminApi(`/admin/webhooks/${id}/test`, { method: "POST" }); setNotice("Test event sent."); load(); }
    catch (e) { setNotice(err(e)); }
  }
  async function remove(id: string) {
    setDeleting(true);
    try { await adminApi(`/admin/webhooks/${id}`, { method: "DELETE" }); load(); }
    catch (e) { setNotice(err(e)); }
    finally { setDeleting(false); setPendingDelete(null); }
  }

  const csvUrl = useMemo(
    () => (deliveries ? URL.createObjectURL(new Blob([toCsv(deliveries)], { type: "text/csv" })) : undefined),
    [deliveries],
  );
  useEffect(() => () => { if (csvUrl) URL.revokeObjectURL(csvUrl); }, [csvUrl]);
  const shown = deliveries?.slice(page * DELIVERY_PAGE, (page + 1) * DELIVERY_PAGE) ?? [];

  return (
    <AdminShell breadcrumbs={["Integrations", "Webhooks"]}>
      <div data-help-id="admin.webhooks.page" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <PageHeader
          eyebrow="Integrations"
          title="Webhooks."
          lede="Send signed events to your own systems when something happens in your organisation."
          actions={<Button onClick={() => setAdding(true)}>Add endpoint</Button>}
        />
        {notice && <div role="status" style={{ fontSize: "var(--aiq-text-sm)" }}>{notice}</div>}

        {adding && (
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", flexWrap: "wrap", alignItems: "center" }}>
            <Input placeholder="Name" aria-label="Name" data-help-id="admin.webhooks.name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 160 }} />
            <Input placeholder="https://example.com/hook" aria-label="URL" data-help-id="admin.webhooks.url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={{ width: 280 }} />
            <Input placeholder="Events, comma-separated" aria-label="Events" data-help-id="admin.webhooks.events" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} style={{ width: 240 }} />
            <Button size="sm" disabled={!form.name.trim() || !form.url.trim()} onClick={() => void create()}>Create</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        )}

        <section data-help-id="admin.webhooks.endpoints" aria-label="Endpoints" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          {!endpoints && !epError && <Spinner />}
          {epError && <div role="alert" style={{ color: "var(--aiq-color-danger)" }}>{epError}</div>}
          {endpoints?.length === 0 && <div style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>No endpoints yet.</div>}
          {endpoints?.map((ep) => (
            <div key={ep.id} className="aiq-card" style={{ padding: "var(--aiq-space-md)", display: "flex", flexWrap: "wrap", gap: "var(--aiq-space-md)", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", wordBreak: "break-all" }}>{ep.url}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {ep.status === "disabled" && <Chip variant="warn">Disabled</Chip>}
                  {ep.events.map((ev) => <Chip key={ev}>{ev}</Chip>)}
                </div>
                {secret?.id === ep.id && (
                  <div role="status" style={{ marginTop: 8, fontSize: "var(--aiq-text-sm)" }}>
                    Signing secret (shown once): <code style={{ fontFamily: "var(--aiq-font-mono)" }}>{secret.value}</code>{" "}
                    <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(secret.value).then(() => setNotice("Secret copied."))}>Copy secret</Button>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
                <Button size="sm" variant="outline" onClick={() => void test(ep.id)}>Test</Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingDelete(ep.id)}>Delete</Button>
              </div>
            </div>
          ))}
        </section>

        <section data-help-id="admin.webhooks.delivery-log" aria-label="Delivery log" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: 18, fontWeight: 400, margin: 0 }}>Delivery log</h2>
            {csvUrl && <a className="aiq-btn aiq-btn-outline aiq-btn-sm" href={csvUrl} download="webhook-deliveries.csv">Export CSV</a>}
          </div>
          {!deliveries && !dlError && <Spinner />}
          {dlError && <div role="alert" style={{ color: "var(--aiq-color-danger)" }}>{dlError}</div>}
          {deliveries && (
            <>
              <div style={{ overflowX: "auto", border: "1px solid var(--aiq-color-border)", borderRadius: 16 }}>
                <Table data={shown} columns={deliveryColumns} emptyMessage="No deliveries yet." />
              </div>
              <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", fontSize: "var(--aiq-text-sm)" }}>
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <span>Page {page + 1} of {Math.max(1, Math.ceil(deliveries.length / DELIVERY_PAGE))}</span>
                <Button variant="outline" size="sm" disabled={(page + 1) * DELIVERY_PAGE >= deliveries.length} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete endpoint"
        body="Delete this endpoint? Deliveries stop immediately."
        confirmLabel="Delete endpoint"
        danger
        busy={deleting}
        onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
    </AdminShell>
  );
}
