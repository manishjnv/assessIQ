// AssessIQ — Admin cohort report page.
//
// /admin/reports/cohort/:assessmentId
//
// Shows: StatCard KPIs + band distribution + leaderboard with anonymize toggle.
// Consumes: GET /api/admin/reports/cohort/:assessmentId
//
// Anonymize toggle stores state in sessionStorage — never logs PII to console.
// ArchetypeRadar shows average across all candidates.

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { StatCard } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { ArchetypeRadar } from "../components/ArchetypeRadar.js";
import { adminApi, AdminApiError } from "../api.js";

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

interface CandidateRow {
  user_id: string;
  email: string;
  total_score: number;
  band: number;
  submitted_at: string;
  archetype_signals?: Record<string, number>;
}

interface CohortReport {
  assessment_name: string;
  level_label: string;
  total_candidates: number;
  median_band: number | null;
  pass_count: number;
  fail_count: number;
  band_distribution: Record<string, number>;
  candidates: CandidateRow[];
  avg_archetype_signals?: Record<string, number>;
}

const ANON_KEY = "aiq.admin.cohort.anonymize";

export function AdminCohortReport(): React.ReactElement {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const [report, setReport] = useState<CohortReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anonymize, setAnonymize] = useState<boolean>(() => {
    try { return sessionStorage.getItem(ANON_KEY) === "true"; } catch { return false; }
  });

  const load = useCallback(async () => {
    if (!assessmentId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<CohortReport>(`/admin/reports/cohort/${assessmentId}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load cohort report.");
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);

  function toggleAnonymize() {
    const next = !anonymize;
    setAnonymize(next);
    try { sessionStorage.setItem(ANON_KEY, String(next)); } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Reports", "Cohort"]} helpPage="admin.reports.cohort">
        <div style={{ padding: "var(--aiq-space-3xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>Loading…</div>
      </AdminShell>
    );
  }

  if (error || !report) {
    return (
      <AdminShell breadcrumbs={["Reports", "Cohort"]} helpPage="admin.reports.cohort">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  return (
    <AdminShell breadcrumbs={["Reports", "Cohort", report.assessment_name]} helpPage="admin.reports.cohort">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <div>
            <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
              {report.assessment_name}
            </h1>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginTop: "var(--aiq-space-xs)" }}>
              {report.level_label} · {report.total_candidates} candidates
            </div>
          </div>
          <button
            type="button"
            className={`aiq-btn aiq-btn-sm ${anonymize ? "aiq-btn-primary" : "aiq-btn-outline"}`}
            onClick={toggleAnonymize}
          >
            {anonymize ? "Show names" : "Anonymize"}
          </button>
        </div>

        {/* KPI row */}
        <div style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <StatCard label="Total candidates" value={report.total_candidates} />
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>Median band</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {report.median_band !== null ? `Band ${report.median_band}` : "—"}
            </div>
          </div>
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>Pass rate</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {report.total_candidates > 0 ? `${Math.round(report.pass_count / report.total_candidates * 100)}%` : "—"}
            </div>
          </div>
        </div>

        {/* Band distribution */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
          <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-md)" }}>Band distribution</h2>
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "flex-end", height: 120 }}>
            {Object.entries(report.band_distribution).map(([band, count]) => {
              const maxCount = Math.max(...Object.values(report.band_distribution), 1);
              const height = Math.max(8, (count / maxCount) * 100);
              return (
                <div key={band} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}>
                  <span style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-secondary)" }}>
                    {count}
                  </span>
                  <div style={{ width: "100%", height, background: "var(--aiq-color-accent-soft)", borderRadius: "var(--aiq-radius-sm) var(--aiq-radius-sm) 0 0" }} />
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 10, textTransform: "uppercase", color: "var(--aiq-color-fg-muted)" }}>
                    {BAND_PCT[Number(band)] ?? band}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Avg archetype radar */}
        {report.avg_archetype_signals && (
          <div className="aiq-card" style={{ padding: "var(--aiq-space-lg)" }}>
            <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-md)" }}>Average archetype signals</h2>
            <ArchetypeRadar signals={report.avg_archetype_signals as unknown as Parameters<typeof ArchetypeRadar>[0]["signals"]} />
          </div>
        )}

        {/* Leaderboard */}
        <div className="aiq-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", borderBottom: "1px solid var(--aiq-color-border)" }}>
            <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0 }}>Leaderboard</h2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--aiq-color-bg-sunken)" }}>
                <th style={{ textAlign: "left", padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", fontWeight: 400 }}>Rank</th>
                <th style={{ textAlign: "left", padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", fontWeight: 400 }}>Candidate</th>
                <th style={{ textAlign: "left", padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", fontWeight: 400 }}>Band</th>
                <th style={{ textAlign: "left", padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", fontWeight: 400 }}>Score</th>
              </tr>
            </thead>
            <tbody>
              {report.candidates
                .sort((a, b) => b.band - a.band || b.total_score - a.total_score)
                .map((c, idx) => (
                  <tr key={c.user_id} style={{ borderTop: "1px solid var(--aiq-color-border)" }}>
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
                      {idx + 1}
                    </td>
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
                      {anonymize ? `Candidate ${idx + 1}` : c.email}
                    </td>
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-sm)" }}>
                      Band {c.band} · {BAND_PCT[c.band] ?? 0}%
                    </td>
                    <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-sm)" }}>
                      {c.total_score}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
