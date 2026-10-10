// AssessIQ — Admin embed configuration page (FU-B15).
//
// Live backend: GET/POST/DELETE /admin/embed-origins ({origin} per call) and
// POST /admin/webhook-secrets/rotate (returns the new secret ONCE). The brief
// named GET/POST /admin/integrations/embed with {origins:[...]}; that route does
// not exist. Consequences: an existing secret cannot be read back, so the secret
// field is empty until "Regenerate" returns a new one; "Save" diffs the local
// origin list against the server and issues one POST/DELETE per change.
//
// INVARIANTS: no claude/anthropic imports.

import React, { useEffect, useState } from "react";
import { Button, Card, ConfirmDialog, Icon, Input, Spinner } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { PageHeader } from "../components/PageHeader.js";
import { adminApi } from "../api.js";

const err = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");
const h2: React.CSSProperties = { fontFamily: "var(--aiq-font-serif)", fontSize: 18, fontWeight: 400, margin: 0 };

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

  useEffect(() => {
    adminApi<{ origins: string[] }>("/admin/embed-origins")
      .then((r) => { setSaved(r.origins); setOrigins(r.origins); })
      .catch((e) => setLoadError(err(e)));
  }, []);

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
    <AdminShell breadcrumbs={["Integrations", "Embed configuration"]}>
      <div data-help-id="admin.embed-config.page" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)", maxWidth: 720 }}>
        <PageHeader eyebrow="Integrations" title="Embed configuration." lede="Control which sites can embed AssessIQ and the secret that signs their requests." />
        {msg && <div role="status" style={{ fontSize: "var(--aiq-text-sm)" }}>{msg}</div>}

        <Card padding="lg">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
            <h2 style={h2}>API Secret</h2>
            <div data-help-id="admin.embed-config.secret" style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
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
            <div data-help-id="admin.embed-config.origins">
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
        title="Regenerate API secret"
        body="Regenerate the API secret? The current secret stops working immediately."
        confirmLabel="Regenerate secret"
        danger
        busy={regenerating}
        onConfirm={() => void regenerate()}
        onCancel={() => setConfirmRegen(false)}
      />
    </AdminShell>
  );
}
