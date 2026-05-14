// AssessIQ — Candidate Activity page.
//
// /candidate/activity — shows the calling candidate's own 52-week activity:
//   - 3 StatCards: completions by domain, assessments taken (count), avg score by quartile
//   - ActivityHeatmap (365-day rolling)
//   - StackedBarChart (52-week timeline by domain)
//   - LeaderboardList (personal pack rankings — best score + rank-in-pack)
//
// Period toggle applies to stats only; heatmap + timeline are rolling 52-week.
// Leaderboard is the candidate's all-time pack history, first page on mount.
//
// INVARIANTS:
//  - No claude/anthropic imports.
//  - All date math is UTC-safe (Date.UTC, not new Date()).

import React, { useEffect, useState, useCallback } from "react";
import {
  StatCard,
  ActivityHeatmap,
  StackedBarChart,
  LeaderboardList,
  Spinner,
} from "@assessiq/ui-system";
import type {
  StatCardBreakdownItem,
  StackedBarChartBar,
  LeaderboardListItem,
} from "@assessiq/ui-system";
import { CandidateShell } from "./CandidateShell.js";
import { candidateApi, CandidateApiError } from "../api.js";

// ---------------------------------------------------------------------------
// API response shapes (mirrors modules/15-analytics types — intentionally
// duplicated to avoid cross-module runtime dependency)
// ---------------------------------------------------------------------------

interface ActivityBreakdownItem {
  key: string;
  value: number;
  pct: number;
}

interface CandidateActivityStatsResponse {
  from: string;
  to: string;
  groupBy: string;
  completions:      { total: number; breakdown: ActivityBreakdownItem[] };
  assessmentsTaken: { total: number };
  avgScore:         { total: number; breakdown: ActivityBreakdownItem[] };
}

interface ActivityHeatmapDay {
  date: string;
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

interface CandidateLeaderboardItem {
  rank: number;
  packId: string | null;
  packName: string | null;
  domain: string | null;
  bestScore: number | null;
  attemptCount: number;
  rankInPack: number | null;
  totalCandidatesInPack: number;
}

interface CandidateActivityLeaderboardResponse {
  page: number;
  pageSize: number;
  totalItems: number;
  items: CandidateLeaderboardItem[];
}

type LeaderboardPeriod = 'week' | 'month' | 'quarter';

// ---------------------------------------------------------------------------
// Domain labels (mirrors admin domains.ts — inline to avoid lib/ dep)
// ---------------------------------------------------------------------------

const DOMAIN_LABELS: Record<string, string> = {
  cognitive:   "Cognitive",
  technical:   "Technical",
  personality: "Personality",
  language:    "Language",
  sales:       "Sales",
  custom:      "Custom",
  cloud:       "Cloud",
  security:    "Security",
  data:        "Data",
  leadership:  "Leadership",
  unknown:     "Other",
};

function domainLabel(slug: string | null): string {
  if (!slug) return "Unknown";
  const label = DOMAIN_LABELS[slug];
  if (label) return label;
  if (!slug) return slug;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

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

function bucketIntensity(count: number): number {
  if (count === 0) return 0;
  if (count <= 2)  return 1;
  if (count <= 5)  return 2;
  if (count <= 10) return 3;
  return 4;
}

function buildHeatmapData(days: ActivityHeatmapDay[]): number[] {
  const countMap = new Map<string, number>();
  for (const d of days) countMap.set(d.date, d.count);

  const todayMs = utcToday();
  const startMs = todayMs - 363 * 86_400_000;
  const startDate = new Date(startMs);
  const dow = startDate.getUTCDay();
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

function buildMonthLabels(): string[] {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const startDate = new Date(utcToday() - 363 * 86_400_000);
  const startMonth = startDate.getUTCMonth();
  return Array.from({ length: 12 }, (_, i) => MONTHS[(startMonth + i) % 12] as string);
}

function statDateParams(period: LeaderboardPeriod): { from: string; to: string } {
  const todayMs = utcToday();
  const days = period === 'week' ? 6 : period === 'month' ? 29 : 89;
  return { from: toDateString(todayMs - days * 86_400_000), to: toDateString(todayMs) };
}

function domainBreakdown(items: ActivityBreakdownItem[]): StatCardBreakdownItem[] {
  return items.map((item) => ({ label: domainLabel(item.key), value: item.value, pct: item.pct }));
}

const QUARTILE_LABELS: Record<string, string> = {
  top_quartile:    "Top quartile",
  above_median:    "Above median",
  below_median:    "Below median",
  bottom_quartile: "Bottom quartile",
};

function quartileBreakdown(items: ActivityBreakdownItem[]): StatCardBreakdownItem[] {
  return items.map((item) => ({
    label: QUARTILE_LABELS[item.key] ?? item.key,
    value: item.value,
    pct:   item.pct,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  week:    "This week",
  month:   "This month",
  quarter: "This quarter",
};

export function CandidateActivity(): React.ReactElement {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');

  const [stats,          setStats]          = useState<CandidateActivityStatsResponse | null>(null);
  const [statsError,     setStatsError]     = useState<string | null>(null);
  const [statsLoading,   setStatsLoading]   = useState(true);

  const [heatmap,        setHeatmap]        = useState<ActivityHeatmapResponse | null>(null);
  const [heatmapError,   setHeatmapError]   = useState<string | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(true);

  const [timeline,        setTimeline]        = useState<ActivityTimelineResponse | null>(null);
  const [timelineError,   setTimelineError]   = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);

  const [leaderboard,        setLeaderboard]        = useState<CandidateActivityLeaderboardResponse | null>(null);
  const [leaderboardError,   setLeaderboardError]   = useState<string | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);

  const fetchStats = useCallback(async (p: LeaderboardPeriod) => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const { from, to } = statDateParams(p);
      const res = await candidateApi<{ data: CandidateActivityStatsResponse }>(
        `/me/activity/stats?from=${from}&to=${to}&groupBy=domain`,
      );
      setStats(res.data);
    } catch (err) {
      setStatsError(err instanceof CandidateApiError ? err.apiError.message : "Failed to load stats.");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchHeatmap = useCallback(async () => {
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const res = await candidateApi<{ data: ActivityHeatmapResponse }>("/me/activity/heatmap");
      setHeatmap(res.data);
    } catch (err) {
      setHeatmapError(err instanceof CandidateApiError ? err.apiError.message : "Failed to load heatmap.");
    } finally {
      setHeatmapLoading(false);
    }
  }, []);

  const fetchTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await candidateApi<{ data: ActivityTimelineResponse }>("/me/activity/timeline");
      setTimeline(res.data);
    } catch (err) {
      setTimelineError(err instanceof CandidateApiError ? err.apiError.message : "Failed to load timeline.");
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const fetchLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const res = await candidateApi<{ data: CandidateActivityLeaderboardResponse }>(
        "/me/activity/leaderboard?page=1&pageSize=10",
      );
      setLeaderboard(res.data);
    } catch (err) {
      setLeaderboardError(err instanceof CandidateApiError ? err.apiError.message : "Failed to load leaderboard.");
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHeatmap();
    void fetchTimeline();
    void fetchLeaderboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchStats(period);
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
  const seriesLabels = (timeline?.domains ?? []).map((d) => domainLabel(d));

  const firstBar = timeline?.bars[0];
  const lastBar  = timeline?.bars[timeline.bars.length - 1];
  const xAxisStartLabel = firstBar
    ? new Date(`${firstBar.weekStart}T00:00:00Z`).toLocaleString("default", { month: "short", year: "numeric", timeZone: "UTC" })
    : undefined;
  const xAxisEndLabel = lastBar
    ? new Date(`${lastBar.weekEnd}T00:00:00Z`).toLocaleString("default", { month: "short", year: "numeric", timeZone: "UTC" })
    : undefined;

  const leaderboardItems: LeaderboardListItem[] = (leaderboard?.items ?? []).map((item) => {
    const score = item.bestScore != null ? `${item.bestScore.toFixed(1)} / 100` : "No score";
    const rankPart = item.rankInPack != null
      ? `#${item.rankInPack} of ${item.totalCandidatesInPack}`
      : null;
    const domainPart = item.domain ? domainLabel(item.domain) : null;
    const sublineParts = [rankPart, domainPart].filter(Boolean);
    return {
      name:   item.packName ?? item.packId ?? "Unknown",
      metric: score,
      ...(sublineParts.length > 0 ? { subline: sublineParts.join(" · ") } : {}),
    };
  });

  // ---- Render ----

  return (
    <CandidateShell>
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: "var(--aiq-space-xl) var(--aiq-space-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--aiq-space-xl)",
        }}
      >

        {/* Page header + period toggle */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--aiq-space-md)" }}>
          <div>
            <h1
              data-help-id="candidate.activity"
              style={{
                fontFamily: "var(--aiq-font-serif)",
                fontSize: "var(--aiq-text-3xl)",
                fontWeight: 400,
                margin: 0,
                color: "var(--aiq-color-fg-primary)",
                letterSpacing: "-0.02em",
              }}
            >
              My activity.
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              Your assessment history and performance across all packs.
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
          <div style={{ display: "flex" }}>
            <Spinner size="sm" aria-label="Loading stats" />
          </div>
        )}
        {statsError && (
          <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
            {statsError}
          </div>
        )}
        {!statsLoading && !statsError && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--aiq-space-md)" }}>
            <StatCard
              label="Assessments completed"
              value={stats?.completions.total ?? 0}
              {...(stats ? { breakdown: domainBreakdown(stats.completions.breakdown) } : {})}
              data-test-id="stat-completions"
            />
            <StatCard
              label="Packs attempted"
              value={stats?.assessmentsTaken.total ?? 0}
              data-test-id="stat-assessments-taken"
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
                Assessments you completed each day, last 52 weeks.
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
            <div style={{ display: "flex" }}>
              <Spinner size="sm" aria-label="Loading heatmap" />
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

        {/* Timeline chart card */}
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
              Weekly completions.
            </h2>
            <p
              style={{
                margin: "4px 0 0",
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-sm)",
                color: "var(--aiq-color-fg-muted)",
              }}
            >
              Assessments you completed each week by domain, last 52 weeks.
            </p>
          </div>

          {timelineLoading && (
            <div style={{ display: "flex" }}>
              <Spinner size="sm" aria-label="Loading timeline" />
            </div>
          )}
          {timelineError && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
              {timelineError}
            </div>
          )}
          {!timelineLoading && !timelineError && chartBars.length === 0 && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No assessment data in the last 52 weeks.
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
            My pack rankings.
          </h2>
          <p
            style={{
              margin: "0 0 var(--aiq-space-lg)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            Your best score and rank among all candidates who took each pack.
          </p>

          {leaderboardLoading && (
            <div style={{ display: "flex" }}>
              <Spinner size="sm" aria-label="Loading leaderboard" />
            </div>
          )}
          {leaderboardError && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-danger)" }}>
              {leaderboardError}
            </div>
          )}
          {!leaderboardLoading && !leaderboardError && leaderboardItems.length === 0 && (
            <div style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" }}>
              No submitted assessments yet.
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
    </CandidateShell>
  );
}
