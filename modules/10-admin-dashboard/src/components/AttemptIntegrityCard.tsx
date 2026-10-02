// Attempt Integrity card (integrity v1): counts of recorded events — not a score,
// shown whatever the release state. Own file so page tests can mock it like the
// other cards (its fetch would otherwise consume their ordered adminApi mocks).
import React, { useEffect, useState } from "react";
import { adminApi } from "../api.js";

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

interface IntegritySummary {
  tab_switches: number;
  copy: number;
  paste: number;
  paste_blocked: number;
  fullscreen_exits: number;
  multi_tab_conflicts: number;
}

/** Integrity card: counts of recorded events. Not a score; shown whatever the release state. */
export function AttemptIntegrityCard({ attemptId }: { attemptId: string }): React.ReactElement | null {
  const [s, setS] = useState<IntegritySummary | null>(null);
  useEffect(() => {
    let live = true;
    adminApi<IntegritySummary>(`/admin/attempts/${attemptId}/integrity`)
      .then((r) => live && setS(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attemptId]);
  if (s === null) return null;
  const rows: Array<[string, number]> = [
    ["Left the test tab", s.tab_switches],
    ["Copied", s.copy],
    ["Pasted", s.paste],
    ["Pasted (blocked)", s.paste_blocked],
    ["Left full screen", s.fullscreen_exits],
    ["Opened in another tab", s.multi_tab_conflicts],
  ];
  const none = rows.every(([, n]) => n === 0);
  return (
    <div
      className="aiq-card aiq-no-print"
      data-help-id="admin.attempt.integrity"
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-lg)" }}
    >
      <span style={MONO_LABEL}>Integrity</span>
      {none ? (
        <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>No events recorded</p>
      ) : (
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content auto", gap: "var(--aiq-space-xs) var(--aiq-space-lg)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
          {rows.map(([label, n]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd style={{ margin: 0, fontWeight: 500 }}>{n}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
