// AssessIQ — Admin individual report page.
//
// /admin/reports/individual/:userId
//
// Shows: Sparkline of auto_pct over time + per-attempt ArchetypeRadar.
// Consumes: GET /api/admin/reports/individual/:userId

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Sparkline, StatCard } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { ArchetypeRadar } from "../components/ArchetypeRadar.js";
import { adminApi, AdminApiError } from "../api.js";

const BAND_PCT: Record<number, number> = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

interface AttemptSummary {
  attempt_id: string;
  assessment_name: string;
  level_label: string;
  submitted_at: string;
  auto_pct: number;
  band: number | null;
  archetype_signals?: Record<string, number>;
}

interface IndividualReport {
  user_id: string;
  email: string;
  total_attempts: number;
  latest_band: number | null;
  attempts: AttemptSummary[];
}

export function AdminIndividualReport(): React.ReactElement {
  const { userId } = useParams<{ userId: string }>();
  const [report, setReport] = useState<IndividualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<IndividualReport>(`/admin/reports/individual/${userId}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load individual report.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <AdminShell breadcrumbs={["Reports", "Individual"]} helpPage="admin.reports.individual">
        <div style={{ padding: "var(--aiq-space-3xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)", fontFamily: "var(--aiq-font-sans)" }}>Loading…</div>
      </AdminShell>
    );
  }

  if (error || !report) {
    return (
      <AdminShell breadcrumbs={["Reports", "Individual"]} helpPage="admin.reports.individual">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const trendData = report.attempts
    .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime())
    .map((a) => a.auto_pct);

  return (
    <AdminShell breadcrumbs={["Reports", "Individual", report.email]} helpPage="admin.reports.individual">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            {report.email}
          </h1>
          <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginTop: "var(--aiq-space-xs)" }}>
            {report.total_attempts} attempts
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap", alignItems: "flex-start" }}>
          <div className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
            <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)", marginBottom: 4 }}>Latest band</div>
            <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
              {report.latest_band !== null ? `Band ${report.latest_band}` : "—"}
            </div>
          </div>
          {trendData.length >= 2 && (
            <div className="aiq-card" style={{ padding: "var(--aiq-space-md)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)", minWidth: 180 }}>
              <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                Score trend
              </span>
              <Sparkline data={trendData} width={160} height={40} />
            </div>
          )}
        </div>

        {/* Per-attempt history */}
        {report.attempts
          .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())
          .map((attempt) => (
            <div key={attempt.attempt_id} className="aiq-card" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--aiq-space-xl)", padding: "var(--aiq-space-xl)", alignItems: "start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
                <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-md)", fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                  {attempt.assessment_name}
                </div>
                <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" }}>
                  {attempt.level_label} · {new Date(attempt.submitted_at).toLocaleDateString()}
                </div>
                <div style={{ fontFamily: "var(--aiq-font-serif)", fontVariantNumeric: "lining-nums tabular-nums", fontSize: "var(--aiq-text-xl)", color: "var(--aiq-color-fg-primary)" }}>
                  {attempt.band !== null ? `Band ${attempt.band} (${BAND_PCT[attempt.band] ?? 0}%)` : "—"}
                </div>
              </div>

              {attempt.archetype_signals && (
                <ArchetypeRadar
                  signals={attempt.archetype_signals as unknown as Parameters<typeof ArchetypeRadar>[0]["signals"]}
                  size={140}
                />
              )}
            </div>
          ))}
      </div>
    </AdminShell>
  );
}
