// AssessIQ — "Test integrity" card on the assessment detail page.
// Edits only settings.integrity via PATCH /admin/assessments/:id/integrity
// (allowed in any status; applies to attempts started afterwards).

import React, { useState } from "react";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../api.js";

export interface IntegrityValue {
  fullscreen?: boolean;
  block_copy_paste?: boolean;
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" };

export function IntegrityCard({
  assessmentId,
  initial,
}: {
  assessmentId: string;
  initial?: IntegrityValue | undefined;
}): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(initial?.fullscreen === true);
  const [blockCopy, setBlockCopy] = useState(initial?.block_copy_paste === true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/admin/assessments/${assessmentId}/integrity`, {
        method: "PATCH",
        body: JSON.stringify({ fullscreen, block_copy_paste: blockCopy }),
      });
      setMsg({ ok: true, text: "Saved. Applies to attempts that start from now on." });
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof AdminApiError ? err.apiError.message : "Could not save. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-help-id="admin.assessment.integrity.edit"
      style={{
        border: "1px solid var(--aiq-color-border)",
        borderRadius: "var(--aiq-radius-md)",
        padding: "var(--aiq-space-md)",
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-sm)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--aiq-space-sm)",
      }}
    >
      <HelpTip helpId="admin.assessment.integrity.edit">
        <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>
          Test integrity
        </h2>
      </HelpTip>
      <label style={row}>
        <input type="checkbox" checked={fullscreen} onChange={(e) => setFullscreen(e.target.checked)} />
        Require full screen
      </label>
      <label style={row}>
        <input type="checkbox" checked={blockCopy} onChange={(e) => setBlockCopy(e.target.checked)} />
        Block copy and paste
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <button type="button" className="aiq-btn aiq-btn-primary aiq-btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save integrity settings"}
        </button>
        {msg && (
          <span
            role={msg.ok ? "status" : "alert"}
            style={{ color: msg.ok ? "var(--aiq-color-success)" : "var(--aiq-color-danger)" }}
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
