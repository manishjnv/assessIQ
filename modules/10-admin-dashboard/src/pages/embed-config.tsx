// AssessIQ — Admin embed configuration page (FU-B15).
//
// Live backend: GET/POST/DELETE /admin/embed-origins ({origin} per call) and
// POST /admin/webhook-secrets/rotate (returns the new secret ONCE). The brief
// named GET/POST /admin/integrations/embed with {origins:[...]}; that route does
// not exist. Consequences: an existing secret cannot be read back, so the secret
// field is empty until "Regenerate" returns a new one; "Save" diffs the local
// origin list against the server and issues one POST/DELETE per change.
//
// RV44 / FU-B14 (2026-10-16): the embed-token signing secret lives in embed_secrets
// (GET/POST /admin/embed-secrets, POST /:id/rotate, DELETE /:id; modules/01-auth
// embed-jwt.ts, 24 h rotation grace). /admin/webhook-secrets/rotate is the WEBHOOK
// HMAC secret, a different key, so it keeps its own card and label below.
//
// INVARIANTS: no claude/anthropic imports.

import React, { useEffect, useState } from "react";
import { Button, Card, ConfirmDialog, Icon, Input, Spinner, formatDate } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { adminApi } from "../api.js";

const err = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");
interface EmbedSecretRow { id: string; name: string; status: "active" | "rotated" | "revoked"; createdAt: string; rotatedAt: string | null }
const day = (iso: string | null): string => (iso ? formatDate(iso) : "-");
const STATUS_LABEL: Record<EmbedSecretRow["status"], string> = { active: "Active", rotated: "Rotated (still valid 24 h)", revoked: "Deleted" };
const h2: React.CSSProperties = { fontFamily: "var(--aiq-font-serif)", fontSize: 18, fontWeight: 400, margin: 0 };

const SNIPPET = `<div id="assessment"></div>
<script src="${typeof window === "undefined" ? "" : window.location.origin}/embed/sdk.js"></script>
<script>
  AssessIQ.mount("#assessment", { token: "<token from your server>" });
</script>`;

export default function EmbedConfigPage(): React.ReactElement {
  const [saved, setSaved] = useState<string[] | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [secrets, setSecrets] = useState<EmbedSecretRow[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const loadSecrets = () =>
    adminApi<{ items: EmbedSecretRow[] }>("/admin/embed-secrets")
      .then((r) => { setSecrets(r.items); setSecretsError(null); })
      .catch((e) => setSecretsError(err(e)));

  useEffect(() => {
    adminApi<{ origins: string[] }>("/admin/embed-origins")
      .then((r) => { setSaved(r.origins); setOrigins(r.origins); })
      .catch((e) => setLoadError(err(e)));
    void loadSecrets();
  }, []);

  async function secretAction(id: string, run: () => Promise<{ plaintextSecret: string } | void>) {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await run();
      if (r) setFresh(r.plaintextSecret);
      await loadSecrets();
    } catch (e) { setMsg(err(e)); } finally { setBusyId(null); setRevokeId(null); }
  }

  const dirty = saved !== null && (origins.length !== saved.length || origins.some((o) => !saved.includes(o)));

  function addOrigin() {
    const o = draft.trim().replace(/\/$/, "");
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(o)) { setMsg("Enter a scheme and host, for example https://yourapp.com."); return; }
    setMsg(null);
    if (!origins.includes(o)) setOrigins([...origins, o]);
    setDraft("");
  }

  async function save() {
    if (!saved) return;
    setSaving(true);
    setMsg(null);
    try {
      for (const o of origins.filter((x) => !saved.includes(x))) await adminApi("/admin/embed-origins", { method: "POST", body: JSON.stringify({ origin: o }) });
      for (const o of saved.filter((x) => !origins.includes(x))) await adminApi("/admin/embed-origins", { method: "DELETE", body: JSON.stringify({ origin: o }) });
      setSaved(origins);
      setMsg("Trusted origins saved.");
    } catch (e) { setMsg(err(e)); } finally { setSaving(false); }
  }

  async function regenerate() {
    setRegenerating(true);
    try {
      const r = await adminApi<{ plaintextSecret: string }>("/admin/webhook-secrets/rotate", { method: "POST" });
      setSecret(r.plaintextSecret);
      setReveal(true);
      setMsg("New secret created. Copy it now; it is not shown again.");
    } catch (e) { setMsg(err(e)); } finally { setRegenerating(false); setConfirmRegen(false); }
  }

  return (
    <AdminShell breadcrumbs={["Integrations", "Embed configuration"]} helpPage="admin.embed">
      <div data-help-id="admin.embed.page" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)", maxWidth: 720 }}>
        <PageHeader eyebrow="Integrations" title="Embed configuration." lede="Control which sites can embed AssessIQ and the secret that signs their requests." />
        {msg && <div role="status" style={{ fontSize: "var(--aiq-text-sm)" }}>{msg}</div>}

        <Card padding="lg">
          <div data-help-id="admin.embed.secrets_list" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 style={h2}>Embed signing secrets</h2>
            <div style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>Your server signs each embed token with an active secret. A rotated secret still works for 24 hours.</div>
            {fresh && (
              <div data-help-id="admin.embed.secret_once" role="status" style={{ border: "1px solid var(--aiq-color-border)", borderRadius: 8, padding: "var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                <strong>Store it now. It is not shown again.</strong>
                <code style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", wordBreak: "break-all" }}>{fresh}</code>
                <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                  <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(fresh).then(() => setMsg("Secret copied."))}>Copy secret</Button>
                  <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>I stored it</Button>
                </div>
              </div>
            )}
            {!secrets && !secretsError && <Spinner />}
            {secretsError && <div role="alert" style={{ color: "var(--aiq-color-danger)" }}>{secretsError}</div>}
            {secrets && secrets.length === 0 && <div style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>No embed secrets yet.</div>}
            {secrets?.map((x) => (
              <div key={x.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap", borderBottom: "1px solid var(--aiq-color-border)", paddingBottom: 6 }}>
                <span style={{ fontSize: "var(--aiq-text-sm)" }}>
                  <strong>{x.name}</strong> · {STATUS_LABEL[x.status]} · created {day(x.createdAt)}{x.rotatedAt ? ` · rotated ${day(x.rotatedAt)}` : ""}
                </span>
                {x.status !== "revoked" && (
                  <span style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
                    {x.status === "active" && (
                      <Button size="sm" variant="outline" disabled={busyId === x.id} onClick={() => void secretAction(x.id, () => adminApi<{ plaintextSecret: string }>(`/admin/embed-secrets/${x.id}/rotate`, { method: "POST" }))}>Rotate</Button>
                    )}
                    <Button size="sm" variant="ghost" style={{ color: "var(--aiq-color-danger)" }} disabled={busyId === x.id} onClick={() => setRevokeId(x.id)}>Delete</Button>
                  </span>
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
              <Input placeholder="Secret name" aria-label="New secret name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Button variant="outline" leftIcon="plus" disabled={!newName.trim() || busyId === "new"} onClick={() => void secretAction("new", () => adminApi<{ plaintextSecret: string }>("/admin/embed-secrets", { method: "POST", body: JSON.stringify({ name: newName.trim() }) }).then((r) => { setNewName(""); return r; }))}>Create</Button>
            </div>
          </div>
        </Card>

        <Card padding="lg">
          <div data-help-id="admin.embed.snippet" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
            <h2 style={h2}>Integration snippet</h2>
            <pre style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", margin: 0, overflowX: "auto" }}>{SNIPPET}</pre>
            <div style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>Mint tokens on your server — see the integration guide.</div>
          </div>
        </Card>

        <Card padding="lg">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 style={h2}>Webhook secret</h2>
            <div data-help-id="admin.embed.webhook_secret" style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", wordBreak: "break-all" }}>
                {secret ? (reveal ? secret : "•".repeat(32)) : "Hidden. Regenerate to see a new secret once."}
              </code>
              {secret && (
                <>
                  <button type="button" aria-label={reveal ? "Hide secret" : "Show secret"} onClick={() => setReveal(!reveal)} style={{ background: "none", border: "none", cursor: "pointer" }}><Icon name="eye" size={16} /></button>
                  <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(secret).then(() => setMsg("Secret copied."))}>Copy</Button>
                </>
              )}
              <Button size="sm" variant="outline" style={{ color: "var(--aiq-color-danger)", borderColor: "var(--aiq-color-danger)" }} onClick={() => setConfirmRegen(true)}>Regenerate</Button>
            </div>
          </div>
        </Card>

        <Card padding="lg">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 style={h2}>Trusted origins</h2>
            <div data-help-id="admin.embed.origins">
            {!saved && !loadError && <Spinner />}
            {loadError && <div role="alert" style={{ color: "var(--aiq-color-danger)" }}>{loadError}</div>}
            {saved && origins.length === 0 && <div style={{ color: "var(--aiq-color-fg-muted)", fontSize: "var(--aiq-text-sm)" }}>No trusted origins yet.</div>}
              {origins.map((o) => (
                <div key={o} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--aiq-color-border)", paddingBottom: 6 }}>
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)" }}>{o}</span>
                  <Button size="sm" variant="ghost" onClick={() => setOrigins(origins.filter((x) => x !== o))}>Remove</Button>
                </div>
              ))}
              <div style={{ display: "flex", gap: "var(--aiq-space-sm)" }}>
                <Input placeholder="https://yourapp.com" aria-label="Add origin" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addOrigin(); }} />
                <Button variant="outline" leftIcon="plus" onClick={addOrigin}>Add</Button>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button disabled={!dirty || saving} loading={saving} onClick={() => void save()}>Save</Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmRegen}
        title="Regenerate webhook secret"
        body="Regenerate the webhook secret? The current secret stops working immediately."
        confirmLabel="Regenerate secret"
        danger
        busy={regenerating}
        onConfirm={() => void regenerate()}
        onCancel={() => setConfirmRegen(false)}
      />
      <ConfirmDialog
        open={revokeId !== null}
        title="Delete embed secret"
        body="Delete this secret? Tokens signed with it stop working immediately."
        confirmLabel="Delete secret"
        danger
        busy={busyId === revokeId}
        onConfirm={() => { const id = revokeId; if (id) void secretAction(id, () => adminApi<void>(`/admin/embed-secrets/${id}`, { method: "DELETE" })); }}
        onCancel={() => setRevokeId(null)}
      />
    </AdminShell>
  );
}
