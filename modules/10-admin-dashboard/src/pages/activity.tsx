// AssessIQ — Admin Activity page.
//
// /admin/activity — shows 52-week activity overview:
//   - 3 StatCards with breakdown (completions by domain, active candidates by domain, avg score by quartile)
//   - ActivityHeatmap (365-day rolling, counts bucketed to 0–4 intensity bands)
//   - StackedBarChart (52-week timeline by domain from timeline endpoint)
//   - LeaderboardList (most-completed packs, paginated with period toggle)
//
// Diverges from screens/activity.jsx:
//   - No "Filter" / "By model" / "View logs" buttons — those are OpenRouter-specific, not applicable here
//   - Period toggle (week/month/quarter) controls stats + leaderboard only;
//     heatmap + timeline always show the rolling 52-week/365-day window
//
// Data fetch pattern: adminApi() with useEffect/useState (matches dashboard.tsx in this package).
// No TanStack Query — consistent with existing admin pages.
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - All date math is UTC-safe (Date.UTC, not new Date()).
//  - Loading state: each section shows "Loading…" until its fetch resolves.
//  - Error state: per-section inline error text.

import React, { useEffect, useState, useCallback } from "react";
import {
  StatCard,
  ActivityHeatmap,
  StackedBarChart,
  LeaderboardList,
} from "@assessiq/ui-system";
import type {
  StatCardBreakdownItem,
  StackedBarChartBar,
  LeaderboardListItem,
} from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";
import { domainLabel } from "../lib/domains.js";

// ---------------------------------------------------------------------------
// API response shapes (mirror modules/15-analytics types — no import to avoid
// cross-module dependency; these are duplicated intentionally)
// ---------------------------------------------------------------------------

interface ActivityBreakdownItem {
  key: string;
  value: number;
  pct: number; // 0–1
}

interface ActivityStatsResponse {
  from: string;
  to: string;
  groupBy: string;
  completions:      { total: number; breakdown: ActivityBreakdownItem[] };
  activeCandidates: { total: number; breakdown: ActivityBreakdownItem[] };
  avgScore:         { total: number; breakdown: ActivityBreakdownItem[] };
}

interface ActivityHeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
}

interface ActivityHeatmapResponse {
  from: string;
  to: string;
  days: ActivityHeatmapDay[];
  totals: { total: number; avgPerDay: number; activeDays: number };
  streaks: { current: number; longest: number };
}

interface ActivityTimelineBar {
  weekStart: string;
  weekEnd: string;
  segments: number[];
  total: number;
}

interface ActivityTimelineResponse {
  from: string;
  to: string;
  domains: string[];
  bars: ActivityTimelineBar[];
}

interface LeaderboardItemRaw {
  rank: number;
  packId: string | null;
  packName: string | null;
  domain: string | null;
  currentCount: number;
  priorCount: number;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
}

interface ActivityLeaderboardResponse {
  period: string;
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
  page: number;
  pageSize: number;
  totalRanked: number;
  items: LeaderboardItemRaw[];
}

type LeaderboardPeriod = 'week' | 'month' | 'quarter';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function utcToday(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

function toDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Bucket a raw submission count into 0–4 intensity band. */
function bucketIntensity(count: number): number {
  if (count === 0) return 0;
  if (count <= 2)  return 1;
  if (count <= 5)  return 2;
  if (count <= 10) return 3;
  return 4;
}

/**
 * Build a 364-cell (52 × 7) column-major intensity array for ActivityHeatmap.
 * idx = weekIndex * 7 + dayOfWeek (0 = Monday, 6 = Sunday).
 * Start is the Monday on or before (today − 363 days).
 */
function buildHeatmapData(days: ActivityHeatmapDay[]): number[] {
  const countMap = new Map<string, number>();
  for (const d of days) countMap.set(d.date, d.count);

  const todayMs = utcToday();
  const startMs = todayMs - 363 * 86_400_000;
  const startDate = new Date(startMs);
  const dow = startDate.getUTCDay(); // 0 = Sun
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mondayMs = startMs - daysToMon * 86_400_000;

  const cells = new Array<number>(364).fill(0);
  for (let i = 0; i < 364; i++) {
    const weekIdx = Math.floor(i / 7);
    const dayIdx  = i % 7;
    const dateStr = toDateString(mondayMs + (weekIdx * 7 + dayIdx) * 86_400_000);
    cells[i] = bucketIntensity(countMap.get(dateStr) ?? 0);
  }
  return cells;
}

/** Derive 12 abbreviated month labels starting from the heatmap's start month. */
function buildMonthLabels(): string[] {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const startDate = new Date(utcToday() - 363 * 86_400_000);
  const startMonth = startDate.getUTCMonth();
  return Array.from({ length: 12 }, (_, i) => MONTHS[(startMonth + i) % 12] as string);
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Map domain-keyed breakdown to StatCard format. */
function domainBreakdown(items: ActivityBreakdownItem[]): StatCardBreakdownItem[] {
  return items.map((item) => ({
    label: domainLabel(item.key),
    value: item.value,
    pct:   item.pct,
  }));
}

// avgScore.breakdown keys are always quartile labels regardless of groupBy
const QUARTILE_LABELS: Record<string, string> = {
  top_quartile:    "Top quartile",
  above_median:    "Above median",
  below_median:    "Below median",
  bottom_quartile: "Bottom quartile",
};

/** Map quartile-keyed breakdown to StatCard format. */
function quartileBreakdown(items: ActivityBreakdownItem[]): StatCardBreakdownItem[] {
  return items.map((item) => ({
    label: QUARTILE_LABELS[item.key] ?? item.key,
    value: item.value,
    pct:   item.pct,
  }));
}

/** Derive stats date range from period. */
function statDateParams(period: LeaderboardPeriod): { from: string; to: string } {
  const todayMs = utcToday();
  const days = period === 'week' ? 6 : period === 'month' ? 29 : 89;
  return { from: toDateString(todayMs - days * 86_400_000), to: toDateString(todayMs) };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  week:    "This week",
  month:   "This month",
  quarter: "This quarter",
};

export function AdminActivity(): React.ReactElement {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');

  const [stats,          setStats]          = useState<ActivityStatsResponse | null>(null);
  const [statsError,     setStatsError]     = useState<string | null>(null);
  const [statsLoading,   setStatsLoading]   = useState(true);

  const [heatmap,        setHeatmap]        = useState<ActivityHeatmapResponse | null>(null);
  const [heatmapError,   setHeatmapError]   = useState<string | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(true);

  const [timeline,        setTimeline]        = useState<ActivityTimelineResponse | null>(null);
  const [timelineError,   setTimelineError]   = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);

  const [leaderboard,        setLeaderboard]        = useState<ActivityLeaderboardResponse | null>(null);
  const [leaderboardError,   setLeaderboardError]   = useState<string | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);

  const fetchStats = useCallback(async (p: LeaderboardPeriod) => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const { from, to } = statDateParams(p);
      const res = await adminApi<{ data: ActivityStatsResponse }>(
        `/admin/activity/stats?from=${from}&to=${to}&groupBy=domain`,
      );
      setStats(res.data);
    } catch (err) {
      setStatsError(err instanceof AdminApiError ? err.apiError.message : "Failed to load stats.");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchHeatmap = useCallback(async () => {
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const res = await adminApi<{ data: ActivityHeatmapResponse }>("/admin/activity/heatmap");
      setHeatmap(res.data);
    } catch (err) {
      setHeatmapError(err instanceof AdminApiError ? err.apiError.message : "Failed to load heatmap.");
    } finally {
      setHeatmapLoading(false);
    }
  }, []);

  const fetchTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await adminApi<{ data: ActivityTimelineResponse }>("/admin/activity/timeline");
      setTimeline(res.data);
    } catch (err) {
      setTimelineError(err instanceof AdminApiError ? err.apiError.message : "Failed to load timeline.");
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const fetchLeaderboard = useCallback(async (p: LeaderboardPeriod) => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const res = await adminApi<{ data: ActivityLeaderboardResponse }>(
        `/admin/activity/leaderboard?period=${p}&page=1&pageSize=10`,
      );
      setLeaderboard(res.data);
    } catch (err) {
      setLeaderboardError(err instanceof AdminApiError ? err.apiError.message : "Failed to load leaderboard.");
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  // Heatmap + timeline: rolling 52-week window, fetch once on mount
  useEffect(() => {
    void fetchHeatmap();
    void fetchTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stats + leaderboard: re-fetch when period changes
  useEffect(() => {
    void fetchStats(period);
    void fetchLeaderboard(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  // ---- Derived display data ----

  const heatmapData   = heatmap ? buildHeatmapData(heatmap.days) : new Array<number>(364).fill(0);
  const monthLabels   = buildMonthLabels();
  const streakSummary = heatmap
    ? `${heatmap.streaks.current}-day streak · longest ${heatmap.streaks.longest} days`
    : undefined;

  const chartBars: StackedBarChartBar[] = (timeline?.bars ?? []).map((b) => ({
    segments: b.segments,
    label:    b.weekStart,
  }));
  const seriesLabels = (timeline?.domains ?? []).map(domainLabel);

  const firstBar = timeline?.bars[0];
  const lastBar  = timeline?.bars[timeline.bars.length - 1];
  const xAxisStartLabel = firstBar
    ? new Date(`${firstBar.weekStart}T00:00:00Z`).toLocaleString("default", { month: "short", year: "numeric", timeZone: "UTC" })
    : undefined;
  const xAxisEndLabel = lastBar
    ? new Date(`${lastBar.weekEnd}T00:00:00Z`).toLocaleString("default", { month: "short", year: "numeric", timeZone: "UTC" })
    : undefined;

  const leaderboardItems: LeaderboardListItem[] = (leaderboard?.items ?? []).map((item) => ({
    name:   item.packName ?? item.packId ?? "Unknown",
    metric: `${formatCount(item.currentCount)} takers`,
    ...(item.domain ? { subline: domainLabel(item.domain) } : {}),
    ...(item.deltaPct !== null
      ? { delta: { value: `${item.deltaPct > 0 ? '+' : ''}${item.deltaPct}%`, up: item.direction === 'up' } }
      : {}),
  }));

  // ---- Render ----

  return (
    <AdminShell breadcrumbs={["Activity"]} helpPage="admin.activity">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>

        {/* Page header + period toggle */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <div>
            <h1
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                color: "var(--aiq-color-fg-primary)",
                letterSpacing: "-0.02em",
              }}
            >
              Activity.
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              Assessment completions and engagement across your tenant.
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--aiq-space-xs)" }}>
            {(["week", "month", "quarter"] as LeaderboardPeriod[]).map((p) => (
              <button
                key={p}
                type="button"
                className={period === p ? "aiq-btn aiq-btn-primary aiq-btn-sm" : "aiq-btn aiq-btn-outline aiq-btn-sm"}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Stat cards */}
        {statsLoading && (
          <div
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            Loading…
          </div>
        )}
        {statsError && (
          <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
            {statsError}
          </div>
        )}
        {!statsLoading && !statsError && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "var(--aiq-space-md)",
            }}
          >
            <StatCard
              label="Assessments completed"
              value={stats?.completions.total ?? 0}
              {...(stats ? { breakdown: domainBreakdown(stats.completions.breakdown) } : {})}
              data-test-id="stat-completions"
            />
            <StatCard
              label="Active candidates"
              value={stats?.activeCandidates.total ?? 0}
              {...(stats ? { breakdown: domainBreakdown(stats.activeCandidates.breakdown) } : {})}
              data-test-id="stat-active-candidates"
            />
            <StatCard
              label="Avg. score"
              value={stats ? Math.round(stats.avgScore.total * 10) / 10 : 0}
              {...(stats ? { breakdown: quartileBreakdown(stats.avgScore.breakdown) } : {})}
              data-test-id="stat-avg-score"
            />
          </div>
        )}

        {/* Activity heatmap card */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-xl)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "var(--aiq-space-md)",
              marginBottom: "var(--aiq-space-lg)",
            }}
          >
            <div>
              <h2
                data-help-id="admin.activity.streak.explanation"
                style={{
                  fontFamily: "var(--aiq-font-serif)",
                  fontSize: "var(--aiq-text-2xl)",
                  fontWeight: 400,
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                Activity streak.
              </h2>
              <p
                style={{
                  margin: "4px 0 0",
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  color: "var(--aiq-color-fg-muted)",
                }}
              >
                Assessments completed each day, last 52 weeks.
              </p>
            </div>
            {heatmap && (
              <div style={{ display: "flex", gap: "var(--aiq-space-xl)" }}>
                {[
                  { label: "Total",       value: heatmap.totals.total.toLocaleString() },
                  { label: "Avg / day",   value: heatmap.totals.avgPerDay.toFixed(1) },
                  { label: "Active days", value: String(heatmap.totals.activeDays) },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div
                      style={{
                        fontFamily: "var(--aiq-font-mono)",
                        fontSize: 10,
                        color: "var(--aiq-color-fg-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        marginBottom: 2,
                      }}
                    >
                      {label}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--aiq-font-serif)",
                        fontSize: "var(--aiq-text-2xl)",
                        fontWeight: 400,
                      }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {heatmapLoading && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </div>
          )}
          {heatmapError && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
              {heatmapError}
            </div>
          )}
          {!heatmapLoading && !heatmapError && (
            <ActivityHeatmap
              data={heatmapData}
              weeks={52}
              monthLabels={monthLabels}
              {...(streakSummary !== undefined ? { streakSummary } : {})}
              aria-label="52-week activity heatmap"
            />
          )}
        </div>

        {/* Stacked bar chart card */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-xl)" }}>
          <div style={{ marginBottom: "var(--aiq-space-lg)" }}>
            <h2
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-2xl)",
                fontWeight: 400,
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Top assessments.
            </h2>
            <p
              style={{
                margin: "4px 0 0",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              Weekly completions by domain, last 52 weeks.
            </p>
          </div>

          {timelineLoading && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </div>
          )}
          {timelineError && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
              {timelineError}
            </div>
          )}
          {!timelineLoading && !timelineError && chartBars.length === 0 && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No assessment data in this window.
            </div>
          )}
          {!timelineLoading && !timelineError && chartBars.length > 0 && (
            <StackedBarChart
              bars={chartBars}
              seriesLabels={seriesLabels}
              {...(xAxisStartLabel !== undefined ? { xAxisStartLabel } : {})}
              {...(xAxisEndLabel !== undefined ? { xAxisEndLabel } : {})}
              aria-label="Weekly completions by domain"
            />
          )}
        </div>

        {/* Leaderboard card */}
        <div className="aiq-card" style={{ padding: "var(--aiq-space-xl)" }}>
          <h2
            style={{
              fontFamily: "var(--aiq-font-serif)",
              fontSize: "var(--aiq-text-2xl)",
              fontWeight: 400,
              margin: "0 0 var(--aiq-space-xs)",
              letterSpacing: "-0.01em",
            }}
          >
            Assessment leaderboard.
          </h2>
          <p
            style={{
              margin: "0 0 var(--aiq-space-lg)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            Most-completed packs on this tenant, {PERIOD_LABELS[period].toLowerCase()}.
          </p>

          {leaderboardLoading && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              Loading…
            </div>
          )}
          {leaderboardError && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
              {leaderboardError}
            </div>
          )}
          {!leaderboardLoading && !leaderboardError && leaderboardItems.length === 0 && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No submissions in this period.
            </div>
          )}
          {!leaderboardLoading && !leaderboardError && leaderboardItems.length > 0 && (
            <LeaderboardList
              items={leaderboardItems}
              columns={2}
            />
          )}
        </div>

      </div>
    </AdminShell>
  );
}
