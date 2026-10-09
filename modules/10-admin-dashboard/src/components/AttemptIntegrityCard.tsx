// "Behaviour and integrity" card on the attempt page (FU-C8, 2026-10-06).
//
// One card with both data sets (RS6 FR11 result "Improve"):
//   - live counts of recorded events — GET /admin/attempts/:id/integrity
//     (not a score; shown whatever the release state)
//   - the behaviour radar from the score snapshot taken at finalize —
//     GET /admin/attempts/:id/score -> score.archetype_signals (null until the
//     result is released to the company, same rule as the score itself)
//   - the disclaimer text (help key admin.scoring.archetype.disclaimer, copied
//     here as visible text per the owner decision: counts are facts, the radar
//     is observational, no label for tenants)
// Owner decisions 2026-10-03: tenant admins see integrity counts only, no
// archetype label; wording "recorded events", never "cheating".
//
// Own file so page tests can mock it like the other cards (its fetches would
// otherwise consume their ordered adminApi mocks).
//
// Help ids sit under the attempt page prefix admin.attempts.detail (the old id
// admin.attempt.integrity could never load there; renamed by migration 0159).
import React, { useEffect, useState } from "react";
import { adminApi } from "../api.js";
import { ArchetypeRadar } from "./ArchetypeRadar.js";

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

interface ScoreEnvelope {
  score: { archetype_signals: Record<string, number> | null } | null;
}

/** Behaviour and integrity card: live counts plus the behaviour radar. Not a score. */
export function AttemptIntegrityCard({ attemptId }: { attemptId: string }): React.ReactElement | null {
  const [s, setS] = useState<IntegritySummary | null>(null);
  const [signals, setSignals] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    adminApi<IntegritySummary>(`/admin/attempts/${attemptId}/integrity`)
      .then((r) => live && setS(r))
      .catch(() => {});
    // The score (and its signals) is null until the result is released to the company.
    adminApi<ScoreEnvelope>(`/admin/attempts/${attemptId}/score`)
      .then((r) => live && setSignals(r.score?.archetype_signals ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attemptId]);
  if (s === null) return null;
  const rows: Array<[string, number]> = [
    ["Left the assessment tab", s.tab_switches],
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
      data-help-id="admin.attempts.detail.integrity"
      style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", padding: "var(--aiq-space-lg)" }}
    >
      <span style={MONO_LABEL}>Behaviour and integrity</span>
      <div style={{ display: "grid", gridTemplateColumns: signals ? "1fr auto" : "1fr", gap: "var(--aiq-space-lg)", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
          <span style={{ ...MONO_LABEL, fontSize: 10 }}>Recorded events</span>
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
        {signals && (
          <div data-help-id="admin.attempts.detail.behaviour" data-test-id="attempt-behaviour-radar" style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
            <span style={{ ...MONO_LABEL, fontSize: 10 }}>Behaviour at finalize</span>
            <ArchetypeRadar signals={signals as unknown as Parameters<typeof ArchetypeRadar>[0]["signals"]} size={160} />
          </div>
        )}
      </div>
      <p style={{ margin: 0, fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", lineHeight: 1.5 }}>
        These are recorded events and behaviour signals, not a score. They never change the result and are not a proxy for integrity.
        Candidates are told that leaving the tab is recorded and shared with you.
      </p>
    </div>
  );
}
