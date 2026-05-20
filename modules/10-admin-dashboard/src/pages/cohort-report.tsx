// AssessIQ — Admin cohort report page.
//
// /admin/reports/cohort/:assessmentId
//
// Shows: attempt count KPI + percentile stats + archetype distribution.
// Consumes: GET /api/admin/reports/cohort/:assessmentId
//   → { stats: { attempt_count, average_pct, p50, p75, p90, archetype_distribution } }
//
// INVARIANT: no claude/anthropic imports.

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Chip, Spinner, StatCard } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { ArchetypeRadar } from "../components/ArchetypeRadar.js";
import { adminApi, AdminApiError } from "../api.js";

interface CohortStats {
  attempt_count: number;
  average_pct: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  archetype_distribution: Record<string, number>;
}

interface CohortResponse {
  stats: CohortStats;
}

export function AdminCohortReport(): React.ReactElement {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const [stats, setStats] = useState<CohortStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assessmentId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<CohortResponse>(`/admin/reports/cohort/${assessmentId}`);
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load cohort report.");
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <AdminShell breadcrumbs={[{ label: "Reports", href: "/admin/reports" }, "Cohort"]} helpPage="admin.reports.cohort">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading cohort report" />
        </div>
      </AdminShell>
    );
  }

  if (error || !stats) {
    return (
      <AdminShell breadcrumbs={[{ label: "Reports", href: "/admin/reports" }, "Cohort"]} helpPage="admin.reports.cohort">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const archetypeEntries = Object.entries(stats.archetype_distribution).sort((a, b) => b[1] - a[1]);
  const maxArchetypeCount = Math.max(...archetypeEntries.map(([, c]) => c), 1);

  return (
    <AdminShell breadcrumbs={[{ label: "Reports", href: "/admin/reports" }, "Cohort"]} helpPage="admin.reports.cohort">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{stats.attempt_count} attempt{stats.attempt_count !== 1 ? "s" : ""}</Chip>
          </div>
          <h1 data-help-id="admin.analytics.cohort_report" style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Cohort Report.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Score distribution and archetype breakdown across all scored attempts.
          </p>
        </div>

        {/* KPI row */}
        <div data-help-id="admin.scoring.cohort.percentiles" style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <StatCard label="Attempts" value={stats.attempt_count} />
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>Avg score</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {stats.average_pct !== null ? `${stats.average_pct}%` : "—"}
            </div>
          </div>
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>Median (p50)</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {stats.p50 !== null ? `${stats.p50}%` : "—"}
            </div>
          </div>
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>P75</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {stats.p75 !== null ? `${stats.p75}%` : "—"}
            </div>
          </div>
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>P90</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {stats.p90 !== null ? `${stats.p90}%` : "—"}
            </div>
          </div>
        </div>

        {/* Archetype distribution */}
        {archetypeEntries.length > 0 && (
          <div className="aiq-card" data-help-id="admin.reports.cohort.distribution" style={{ padding: "var(--aiq-space-lg)" }}>
            <h2 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-md)" }}>Archetype distribution</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              {archetypeEntries.map(([archetype, count]) => (
                <div key={archetype} style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
                  <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--aiq-color-fg-muted)", width: 160, flexShrink: 0 }}>
                    {archetype}
                  </div>
                  <div style={{ flex: 1, height: 12, background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-full)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(count / maxArchetypeCount) * 100}%`, background: "var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-full)" }} />
                  </div>
                  <div style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-sm)", width: 32, textAlign: "right" }}>
                    {count}
                  </div>
                </div>
              ))}
            </div>
            {Object.keys(stats.archetype_distribution).length > 0 && (
              <div style={{ marginTop: "var(--aiq-space-lg)" }}>
                <ArchetypeRadar signals={stats.archetype_distribution as unknown as Parameters<typeof ArchetypeRadar>[0]["signals"]} />
              </div>
            )}
          </div>
        )}

        {archetypeEntries.length === 0 && stats.attempt_count === 0 && (
          <div className="aiq-card" style={{ padding: "var(--aiq-space-xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>
            No scored attempts yet for this assessment.
          </div>
        )}
      </div>
    </AdminShell>
  );
}
