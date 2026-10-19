// CreditsCard - Z-93 / Z-79: credit balance and offline grant form (super admin, Platform billing drawer).

import React, { useEffect, useState } from "react";
import { Card } from "@assessiq/ui-system";
import { AdminApiError, getTenantCredits, grantTenantCredits, type CreditGrantRow, type CreditBurnTotals } from "../../api.js";
import { META_LABEL, formatDate } from "./shared.js";

const FIELD = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: "var(--aiq-radius-md)",
  border: "1px solid var(--aiq-color-border)",
  background: "var(--aiq-color-bg-raised)",
  color: "var(--aiq-color-fg-primary)",
} as const;

export function CreditsCard({ tenantId, readOnly }: { tenantId: string; readOnly: boolean }): React.ReactElement {
  const [grants, setGrants] = useState<CreditGrantRow[]>([]);
  const [burns, setBurns] = useState<CreditBurnTotals>({ mock: 0, real: 0, real_camera: 0 });
  const [credits, setCredits] = useState("");
  const [source, setSource] = useState<"purchase" | "bonus" | "pilot">("purchase");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = (): void => {
    getTenantCredits(tenantId)
      .then((r) => { setGrants(r.grants); setBurns(r.burns); })
      .catch(() => setError("Could not load the credit balance."));
  };
  useEffect(load, [tenantId]);

  const now = Date.now();
  const live = grants.filter((g) => g.remaining > 0 && Date.parse(g.expires_at) > now);
  const balance = live.reduce((a, g) => a + g.remaining, 0);
  const nextExpiry = live.length > 0 ? live.map((g) => g.expires_at).sort()[0] : null;

  const submit = async (): Promise<void> => {
    const n = parseInt(credits, 10);
    if (!Number.isInteger(n) || n < 1) { setError("Enter a whole number of credits, 1 or more."); return; }
    setSaving(true);
    setError(null);
    setDone(null);
    try {
      const res = await grantTenantCredits(tenantId, {
        credits: n,
        source,
        ...(invoiceRef.trim() ? { invoiceRef: invoiceRef.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setDone(`Credits added. Audit: ${res.auditId}`);
      setCredits("");
      setInvoiceRef("");
      setNote("");
      load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Save failed. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)", padding: "var(--aiq-space-lg)" }}>
        <span style={{ ...META_LABEL, fontSize: "var(--aiq-text-xs)" }}>Credits</span>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 13, margin: 0 }}>
          Balance <strong>{balance}</strong>
          {nextExpiry !== null ? ` · next expiry ${formatDate(nextExpiry)}` : ""}
          {` · burned: mock ${burns.mock}, real ${burns.real}, real + camera ${burns.real_camera}`}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input aria-label="Credits to add" type="number" min={1} value={credits} placeholder="Credits" disabled={readOnly}
            onChange={(e) => setCredits(e.target.value)} style={FIELD} />
          <select aria-label="Grant source" value={source} disabled={readOnly}
            onChange={(e) => setSource(e.target.value as "purchase" | "bonus" | "pilot")} style={FIELD}>
            <option value="purchase">purchase</option>
            <option value="bonus">bonus</option>
            <option value="pilot">pilot</option>
          </select>
          <input aria-label="Invoice reference" value={invoiceRef} placeholder="Invoice reference" disabled={readOnly}
            onChange={(e) => setInvoiceRef(e.target.value)} style={FIELD} />
          <input aria-label="Note" value={note} placeholder="Note" disabled={readOnly}
            onChange={(e) => setNote(e.target.value)} style={FIELD} />
        </div>
        {error !== null && (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-danger, #dc2626)", margin: 0 }}>{error}</p>
        )}
        {done !== null && (
          <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: 12, color: "var(--aiq-color-success, #16a34a)", margin: 0 }}>{done}</p>
        )}
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={readOnly || saving} onClick={() => void submit()}>
          {saving ? "Saving…" : "Add credits"}
        </button>
      </div>
    </Card>
  );
}
