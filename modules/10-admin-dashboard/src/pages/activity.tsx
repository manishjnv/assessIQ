// AssessIQ — Admin Activity page.
//
// /admin/activity — shows 52-week activity overview:
//   - ActivityFeedSection (NEW — chronological role-filterable event feed, rendered FIRST)
//   - 3 StatCards with breakdown (completions by domain, active candidates by domain, avg score by quartile)
//   - ActivityHeatmap (365-day rolling, counts bucketed to 0–4 intensity bands)
//   - StackedBarChart (52-week timeline by domain from timeline endpoint)
//   - LeaderboardList (most-completed packs, paginated with period toggle)
//
// Diverges from screens/activity.jsx:
//   - No "Filter" / "By model" / "View logs" buttons — those are OpenRouter-specific, not applicable here
//   - Period toggle (week/month/quarter) controls stats + leaderboard only;
//     heatmap + timeline always show the rolling 52-week/365-day window
//   - ActivityFeedSection added above stat cards: role-filterable event feed backed by
//     GET /api/admin/activity/feed; mirrors leaderboard row idiom + kit btn-sm filter tabs
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
  Chip,
  ErasedChip,
  useViewport,
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
// Activity feed — API response shapes (duplicated intentionally; no cross-module import)
// ---------------------------------------------------------------------------

type FeedRole = 'admin' | 'reviewer' | 'candidate' | 'system';
type FeedRoleFilter = 'all' | FeedRole;

interface ActivityFeedItem {
  id: string;
  source: 'audit' | 'attempt';
  at: string; // ISO-8601
  actorRole: FeedRole;
  actorLabel: string;
  /** True when the actor candidate has been erased. Defensive: server-side
   *  already drops erased-candidate rows but we render safely if any slip through. */
  isErased?: boolean;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
}

interface ActivityFeedResponse {
  page: number;
  pageSize: number;
  total: number;
  items: ActivityFeedItem[];
}

// ---------------------------------------------------------------------------
// Activity feed — pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable relative time string for an ISO timestamp.
 * UTC-safe: uses getTime() arithmetic, not locale-dependent formatting.
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "May 28"
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const nowMs = Date.now();
  const diffMs = nowMs - then;
  if (diffMs < 0) return "just now"; // future-proof / clock skew
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  // Older than a week: show "Mon DD" UTC
  const d = new Date(iso);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Role badge color map (reuses chart palette via CSS custom properties for tokens)
const ROLE_CHIP_VARIANT: Record<FeedRole, "default" | "accent" | "success" | "warn"> = {
  admin:     "accent",
  reviewer:  "warn",
  candidate: "success",
  system:    "default",
};

const ROLE_LABEL: Record<FeedRole, string> = {
  admin:     "Admin",
  reviewer:  "Reviewer",
  candidate: "Candidate",
  system:    "System",
};

const FEED_ROLE_FILTERS: { value: FeedRoleFilter; label: string }[] = [
  { value: "all",       label: "All" },
  { value: "admin",     label: "Admin" },
  { value: "reviewer",  label: "Reviewer" },
  { value: "candidate", label: "Candidate" },
];

const FEED_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// ActivityFeedSection sub-component
// ---------------------------------------------------------------------------

function ActivityFeedSection(): React.ReactElement {
  const [roleFilter, setRoleFilter] = useState<FeedRoleFilter>("all");
  const [items, setItems]           = useState<ActivityFeedItem[]>([]);
  const [total, setTotal]           = useState<number>(0);
  const [page, setPage]             = useState<number>(1);
  const [loading, setLoading]       = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Fetch page 1 whenever the role filter changes (reset list)
  const fetchFeed = useCallback(async (role: FeedRoleFilter, nextPage: number, append: boolean) => {
    if (nextPage === 1) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams({
        role,
        page:     String(nextPage),
        pageSize: String(FEED_PAGE_SIZE),
      });
      const res = await adminApi<ActivityFeedResponse>(`/admin/activity/feed?${params.toString()}`);
      setTotal(res.total);
      setPage(nextPage);
      setItems((prev) => append ? [...prev, ...res.items] : res.items);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load activity feed.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void fetchFeed(roleFilter, 1, false);
  }, [roleFilter]);

  const handleLoadMore = () => {
    void fetchFeed(roleFilter, page + 1, true);
  };

  const hasMore = items.length < total;

  return (
    <div
      className="aiq-card"
      style={{ padding: "var(--aiq-space-xl)" }}
      data-help-id="admin.activity.feed"
    >
      {/* Section heading */}
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
              color: "var(--aiq-color-fg-primary)",
            }}
          >
            Activity.
          </h2>
          <p
            style={{
              margin: "4px 0 0",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-fg-muted)",
            }}
          >
            Everything happening across your workspace — admins, reviewers, and candidates.
          </p>
        </div>

        {/* Role filter tabs — kit btn-sm pill pattern (activity.jsx header) */}
        <div
          className="aiq-admin-filter-strip"
          style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}
          role="group"
          aria-label="Filter activity by role"
        >
          {FEED_ROLE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={
                roleFilter === value
                  ? "aiq-btn aiq-btn-primary aiq-btn-sm"
                  : "aiq-btn aiq-btn-outline aiq-btn-sm"
              }
              onClick={() => setRoleFilter(value)}
              aria-pressed={roleFilter === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state — per-section "Loading…" pattern matching existing sections */}
      {loading && (
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

      {/* Inline error — matches existing per-section error pattern */}
      {!loading && error && (
        <div
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            color: "var(--aiq-color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && (
        <div
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            color: "var(--aiq-color-fg-muted)",
            padding: "var(--aiq-space-xl) 0",
            textAlign: "center",
          }}
        >
          No activity yet.
        </div>
      )}

      {/* Feed rows — kit leaderboard row idiom: `<div className="row" style={{ padding:"12px 0", borderBottom:... }}>`  */}
      {!loading && !error && items.length > 0 && (
        <>
          <div role="list" aria-label="Activity feed">
            {items.map((item, idx) => {
              const isLast = idx === items.length - 1;
              return (
                <div
                  key={item.id}
                  role="listitem"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "var(--aiq-space-md)",
                    padding: "12px 0",
                    borderBottom: isLast ? "none" : "1px solid var(--aiq-color-border)",
                  }}
                >
                  {/* Role badge — Chip from @assessiq/ui-system */}
                  <div style={{ flexShrink: 0, paddingTop: 1 }}>
                    <Chip variant={ROLE_CHIP_VARIANT[item.actorRole]}>
                      {ROLE_LABEL[item.actorRole]}
                    </Chip>
                  </div>

                  {/* Main content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-sm)",
                        color: item.isErased ? "var(--aiq-color-fg-muted)" : "var(--aiq-color-fg-primary)",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--aiq-space-xs)",
                      }}
                    >
                      {item.actorLabel}
                      {item.isErased && <ErasedChip />}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--aiq-font-sans)",
                        fontSize: "var(--aiq-text-sm)",
                        color: "var(--aiq-color-fg-muted)",
                        marginTop: 2,
                      }}
                    >
                      {item.actionLabel}
                      {item.targetLabel ? (
                        <span style={{ color: "var(--aiq-color-fg-secondary)" }}>
                          {" · "}
                          {item.targetLabel}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Relative timestamp — right-aligned, mono microcopy */}
                  <div
                    style={{
                      flexShrink: 0,
                      fontFamily: "var(--aiq-font-mono)",
                      fontSize: 11,
                      color: "var(--aiq-color-fg-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      paddingTop: 2,
                      whiteSpace: "nowrap",
                    }}
                    title={item.at}
                  >
                    {relativeTime(item.at)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Count + load more */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: "var(--aiq-space-md)",
              flexWrap: "wrap",
              gap: "var(--aiq-space-sm)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--aiq-font-mono)",
                fontSize: 11,
                color: "var(--aiq-color-fg-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Showing {items.length} of {total}
            </span>

            {hasMore && (
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{ color: "var(--aiq-color-fg-muted)" }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
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
  const viewport = useViewport();
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
  }, []);

  // Stats + leaderboard: re-fetch when period changes
  useEffect(() => {
    void fetchStats(period);
    void fetchLeaderboard(period);
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

        {/* Activity feed — rendered FIRST, above all existing sections */}
        <ActivityFeedSection />

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
          <div className="aiq-admin-filter-strip" style={{ display: "flex", gap: "var(--aiq-space-xs)", flexWrap: "wrap" }}>
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
            className="aiq-candidate-activity-stats"
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
            <div data-help-id="admin.activity.heatmap.legend">
              <div className="aiq-candidate-activity-heatmap-scroll" style={{ overflowX: "auto" }}>
                <ActivityHeatmap
                  data={heatmapData}
                  weeks={52}
                  monthLabels={monthLabels}
                  {...(streakSummary !== undefined ? { streakSummary } : {})}
                  aria-label="52-week activity heatmap"
                />
              </div>
            </div>
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
            <div data-help-id="admin.activity.leaderboard.delta">
              <LeaderboardList
                items={leaderboardItems}
                columns={viewport === 'mobile' ? 1 : 2}
              />
            </div>
          )}
        </div>

      </div>
    </AdminShell>
  );
}
