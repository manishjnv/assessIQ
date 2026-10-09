// AssessIQ — Admin cohort report page.
//
// /admin/reports/cohort/:assessmentId
//
// Shows: attempt count KPI + percentile stats + archetype distribution
// (09 cohortStats), then FU-C4 (2026-10-06): level and topic breakdown
// (15 cohortReport) and the topic heatmap for a selectable question pack
// (15 topicHeatmap). All four sources apply the tenant-visible rule
// (released / evaluation-released only; MV 0122, FU-C3).
//
// Consumes:
//   GET /api/admin/reports/cohort/:assessmentId            → { stats }
//   GET /api/admin/reports/cohort/:assessmentId/breakdown  → { data: { levelBreakdown, topicBreakdown } }
//   GET /api/admin/assessments/:id                         → { pack_id } (default pack for the heatmap)
//   GET /api/admin/packs?pageSize=100                      → { items } (pack selector)
//   GET /api/admin/reports/topic-heatmap?packId=           → { data: { cells } }
//
// Kit: stat-card row, card with mono eyebrow + bar rows (same idiom as the
// archetype distribution below), native <select> for the pack (no kit
// select recipe; the same control the assessments and billing pages use).
//
// INVARIANT: no claude/anthropic imports.

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Chip, Spinner, StatCard } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
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

interface LevelBreakdown {
  levelId: string;
  levelLabel: string;
  attemptCount: number;
  averagePct: number | null;
}

interface TopicBreakdownItem {
  topic: string;
  attemptsCount: number;
  averagePct: number | null;
  hitRatePct: number | null;
}

interface BreakdownResponse {
  data: { levelBreakdown: LevelBreakdown[]; topicBreakdown: TopicBreakdownItem[] };
}

interface HeatmapCell {
  topic: string;
  attemptsCount: number;
  attemptsCorrect: number;
  hitRatePct: number;
  meanBand: number | null;
  p50Band: number | null;
}

interface HeatmapResponse {
  data: { packId: string; cells: HeatmapCell[] };
}

interface PackOption {
  id: string;
  name: string;
}

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

const NUM: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontVariantNumeric: "lining-nums tabular-nums",
  fontSize: "var(--aiq-text-sm)",
  textAlign: "right",
};

const H2: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)",
  fontSize: "var(--aiq-text-xl)",
  fontWeight: 400,
  margin: "0 0 var(--aiq-space-md)",
};

const pct = (v: number | null): string => (v !== null ? `${Math.round(v * 10) / 10}%` : "—");

/** Bar row: label, neutral bar filled to value/max, number. Same idiom as the archetype rows. */
function BarRow({ label, value, max, text }: { label: string; value: number; max: number; text: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)" }}>
      <div style={{ ...MONO_LABEL, width: 160, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>
        {label}
      </div>
      <div style={{ flex: 1, height: 12, background: "var(--aiq-color-bg-sunken)", borderRadius: "var(--aiq-radius-full)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, background: "var(--aiq-color-accent)", borderRadius: "var(--aiq-radius-full)" }} />
      </div>
      <div style={{ ...NUM, width: 120 }}>{text}</div>
    </div>
  );
}

export function AdminCohortReport(): React.ReactElement {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const [stats, setStats] = useState<CohortStats | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownResponse["data"] | null>(null);
  const [packs, setPacks] = useState<PackOption[]>([]);
  const [packId, setPackId] = useState<string>("");
  const [heatmap, setHeatmap] = useState<HeatmapCell[] | null>(null);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assessmentId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<CohortResponse>(`/admin/reports/cohort/${assessmentId}`);
      setStats(data.stats);
      // FU-C4: the breakdown, the assessment's pack and the pack list are
      // secondary; a failure there does not blank the page.
      const [bd, asm, pk] = await Promise.allSettled([
        adminApi<BreakdownResponse>(`/admin/reports/cohort/${assessmentId}/breakdown`),
        adminApi<{ pack_id: string | null }>(`/admin/assessments/${assessmentId}`),
        adminApi<{ items: PackOption[] }>(`/admin/packs?pageSize=100`),
      ]);
      if (bd.status === "fulfilled") setBreakdown(bd.value.data);
      if (pk.status === "fulfilled") setPacks(pk.value.items.map((p) => ({ id: p.id, name: p.name })));
      if (asm.status === "fulfilled" && asm.value.pack_id) setPackId(asm.value.pack_id);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load cohort report.");
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!packId) { setHeatmap(null); return; }
    let live = true;
    setHeatmapError(null);
    adminApi<HeatmapResponse>(`/admin/reports/topic-heatmap?packId=${encodeURIComponent(packId)}`)
      .then((r) => { if (live) setHeatmap(r.data.cells); })
      .catch((err) => { if (live) setHeatmapError(err instanceof AdminApiError ? err.apiError.message : "Failed to load the heatmap."); });
    return () => { live = false; };
  }, [packId]);

  const crumbs = [{ label: "Reports", href: "/admin/reports" }, "Cohort"];

  if (loading) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.reports.cohort">
        <div style={{ padding: "var(--aiq-space-3xl)", display: "flex", justifyContent: "center" }}>
          <Spinner aria-label="Loading cohort report" />
        </div>
      </AdminShell>
    );
  }

  if (error || !stats) {
    return (
      <AdminShell breadcrumbs={crumbs} helpPage="admin.reports.cohort">
        <div style={{ color: "var(--aiq-color-danger)", padding: "var(--aiq-space-xl)" }}>{error ?? "Not found."}</div>
      </AdminShell>
    );
  }

  const archetypeEntries = Object.entries(stats.archetype_distribution).sort((a, b) => b[1] - a[1]);
  const maxArchetypeCount = Math.max(...archetypeEntries.map(([, c]) => c), 1);
  const levels = breakdown?.levelBreakdown ?? [];
  const topics = breakdown?.topicBreakdown ?? [];
  const maxLevelAttempts = Math.max(...levels.map((l) => l.attemptCount), 1);
  const packName = packs.find((p) => p.id === packId)?.name;

  return (
    <AdminShell breadcrumbs={crumbs} helpPage="admin.reports.cohort">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{stats.attempt_count} attempt{stats.attempt_count !== 1 ? "s" : ""}</Chip>
          </div>
          <h1 data-help-id="admin.reports.cohort.report" style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Cohort Report.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Score distribution, difficulty and topic breakdown across the released attempts of this assessment.
          </p>
        </div>

        {/* KPI row */}
        <div data-help-id="admin.reports.cohort.percentiles" style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <StatCard label="Attempts" value={stats.attempt_count} />
          {([
            ["Avg score", stats.average_pct],
            ["Median (p50)", stats.p50],
            ["P75", stats.p75],
            ["P90", stats.p90],
          ] as Array<[string, number | null]>).map(([label, v]) => (
            <div key={label} className="aiq-card" style={{ padding: "var(--aiq-space-md) var(--aiq-space-lg)", minWidth: 140 }}>
              <div style={{ ...MONO_LABEL, marginBottom: 4 }}>{label}</div>
              <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontVariantNumeric: "lining-nums tabular-nums", fontWeight: 400 }}>
                {v !== null ? `${v}%` : "—"}
              </div>
            </div>
          ))}
        </div>

        {/* By level — FU-C4 */}
        <div className="aiq-card" data-help-id="admin.reports.cohort.by_level" style={{ padding: "var(--aiq-space-lg)" }}>
          <h2 style={H2}>By difficulty</h2>
          {levels.length === 0 ? (
            <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>No released attempt yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              {levels.map((l) => (
                <BarRow key={l.levelId} label={l.levelLabel} value={l.attemptCount} max={maxLevelAttempts} text={`${l.attemptCount} · avg ${pct(l.averagePct)}`} />
              ))}
            </div>
          )}
        </div>

        {/* By topic — FU-C4 */}
        <div className="aiq-card" data-help-id="admin.reports.cohort.by_topic" style={{ padding: "var(--aiq-space-lg)" }}>
          <h2 style={H2}>By topic</h2>
          {topics.length === 0 ? (
            <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>No released attempt yet.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 110px 110px", gap: "var(--aiq-space-xs) var(--aiq-space-md)", alignItems: "center" }}>
              <span style={MONO_LABEL}>Topic</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Attempts</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Average</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Hit rate</span>
              {topics.map((t) => (
                <React.Fragment key={t.topic}>
                  <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{t.topic}</span>
                  <span style={NUM}>{t.attemptsCount}</span>
                  <span style={NUM}>{pct(t.averagePct)}</span>
                  <span style={NUM}>{pct(t.hitRatePct)}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* Topic heatmap with pack selector — FU-C4 */}
        <div className="aiq-card" data-help-id="admin.reports.cohort.heatmap" style={{ padding: "var(--aiq-space-lg)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-md)", flexWrap: "wrap", marginBottom: "var(--aiq-space-md)" }}>
            <h2 style={{ ...H2, margin: 0 }}>Topic heatmap</h2>
            <span style={{ flex: 1 }} />
            <label data-help-id="admin.reports.cohort.pack" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-xs)" }}>
              <span style={MONO_LABEL}>Question set</span>
              <select
                value={packId}
                onChange={(e) => setPackId(e.target.value)}
                style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", padding: "var(--aiq-space-xs) var(--aiq-space-sm)", border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", maxWidth: 320 }}
                aria-label="Question set"
              >
                <option value="">Choose a question set</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                {packId && !packs.some((p) => p.id === packId) && <option value={packId}>Question set of this assessment</option>}
              </select>
            </label>
          </div>
          {heatmapError && <div style={{ marginBottom: "var(--aiq-space-sm)" }}><Chip>{heatmapError}</Chip></div>}
          {!packId ? (
            <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>Choose a question set to see its topics.</p>
          ) : heatmap === null ? (
            <Spinner size="sm" aria-label="Loading heatmap" />
          ) : heatmap.length === 0 ? (
            <p style={{ margin: 0, fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>No released answer yet for {packName ?? "this question set"}.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 100px 100px 100px", gap: "var(--aiq-space-xs) var(--aiq-space-md)", alignItems: "center" }}>
              <span style={MONO_LABEL}>Topic</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Answers</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Correct</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Hit rate</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Mean score band</span>
              <span style={{ ...MONO_LABEL, textAlign: "right" }}>Median score band</span>
              {heatmap.map((c) => (
                <React.Fragment key={c.topic}>
                  <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>{c.topic}</span>
                  <span style={NUM}>{c.attemptsCount}</span>
                  <span style={NUM}>{c.attemptsCorrect}</span>
                  <span style={{ ...NUM, background: `color-mix(in oklab, var(--aiq-color-accent) ${Math.round(Math.min(100, Math.max(0, c.hitRatePct)) * 0.35)}%, transparent)`, borderRadius: "var(--aiq-radius-sm)", padding: "2px 6px" }}>
                    {pct(c.hitRatePct)}
                  </span>
                  <span style={NUM}>{c.meanBand !== null ? c.meanBand.toFixed(1) : "—"}</span>
                  <span style={NUM}>{c.p50Band !== null ? c.p50Band.toFixed(1) : "—"}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* Archetype distribution */}
        {archetypeEntries.length > 0 && (
          <div className="aiq-card" data-help-id="admin.reports.cohort.distribution" style={{ padding: "var(--aiq-space-lg)" }}>
            <h2 style={H2}>Archetype distribution</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
              {archetypeEntries.map(([archetype, count]) => (
                <BarRow key={archetype} label={archetype} value={count} max={maxArchetypeCount} text={String(count)} />
              ))}
            </div>
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
