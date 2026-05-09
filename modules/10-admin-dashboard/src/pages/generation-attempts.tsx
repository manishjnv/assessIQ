// AssessIQ — Admin Generation Attempts history page.
//
// /admin/generation-attempts
//
// Cross-pack, paginated history of every AI question-generation run.
// Lets the team diagnose success/partial/failed rates, per-skill timing,
// and recent stderr_tails without SSH'ing the VPS.
//
// Fetches:
//   GET /api/admin/generation-attempts  → { items, total, limit, offset }
//   GET /api/admin/packs                → pack list (for name resolution)
//
// INVARIANTS:
//  - Read-only. No mutations on generation_attempts.
//  - No new dependency — uses Intl.DateTimeFormat / Intl.RelativeTimeFormat
//    (same pattern as pack-detail.tsx).
//  - Filter state is client-side React state; no URL params, no localStorage.
//  - stderr_tail rendered in <pre> with max-height + overflow-auto.
//  - No claude/anthropic imports or copy.

import React, { useEffect, useState, useCallback } from "react";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GenerationAttemptStatus = "success" | "partial" | "failed" | "running";

interface GenerationAttempt {
  id: string;
  status: GenerationAttemptStatus;
  count_requested: number;
  count_inserted: number;
  error_code: string | null;
  error_message: string | null;
  stderr_tail: string | null;
  skill_sha: string | null;
  model: string | null;
  chunks_planned: number | null;
  chunks_failed: number | null;
  dedupe_dropped: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  pack_id: string;
  level_id: string;
  user_id: string | null;
}

interface GenerationAttemptsResponse {
  items: GenerationAttempt[];
  total: number;
  limit: number;
  offset: number;
}

interface PackItem {
  id: string;
  name: string;
  levels?: Array<{ id: string; label: string }>;
}

interface PacksResponse {
  items: PackItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Date / duration helpers (mirrors pack-detail.tsx)
// ---------------------------------------------------------------------------

function attemptDate(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) {
    const minutes = Math.floor(diff / 60_000);
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
    if (minutes < 1) return "just now";
    if (hours < 1) return rtf.format(-minutes, "minute");
    return rtf.format(-hours, "hour");
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoStr));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<GenerationAttemptStatus, { bg: string; fg: string; label: string }> = {
  success: { bg: "var(--aiq-color-success-soft)", fg: "var(--aiq-color-success)",        label: "Success"  },
  partial: { bg: "#fef3c7",                        fg: "var(--aiq-color-warning, #d97706)", label: "Partial"  },
  failed:  { bg: "#fee2e2",                        fg: "var(--aiq-color-danger)",           label: "Failed"   },
  running: { bg: "var(--aiq-color-accent-soft)",  fg: "var(--aiq-color-accent)",           label: "Running"  },
};

function StatusPill({ status }: { status: GenerationAttemptStatus }): React.ReactElement {
  const { bg, fg, label } = STATUS_COLORS[status] ?? STATUS_COLORS.failed;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: "var(--aiq-radius-full, 9999px)",
        background: bg,
        color: fg,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

type DateRange = "24h" | "7d" | "30d" | "all";

function dateRangeToSince(range: DateRange): string | undefined {
  if (range === "all") return undefined;
  const ms = range === "24h" ? 86_400_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// Row expansion — details panel
// ---------------------------------------------------------------------------

function AttemptDetails({ attempt, packName, levelLabel }: {
  attempt: GenerationAttempt;
  packName: string;
  levelLabel: string;
}): React.ReactElement {
  const cliCommand =
    `pnpm -C modules/07-ai-grading exec tsx eval/cli-typed.ts \\\n` +
    `  score-candidate --attempt-id ${attempt.id}`;

  return (
    <div
      style={{
        padding: "var(--aiq-space-md) var(--aiq-space-lg)",
        background: "var(--aiq-color-bg-sunken)",
        borderTop: "1px solid var(--aiq-color-border)",
      }}
    >
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: "var(--aiq-space-lg)",
          rowGap: "var(--aiq-space-xs)",
          fontFamily: "var(--aiq-font-mono)",
          fontSize: "var(--aiq-text-xs)",
          margin: 0,
        }}
      >
        <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Attempt ID</dt>
        <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>{attempt.id}</dd>

        <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Pack / Level</dt>
        <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>
          {packName} / {levelLabel}
        </dd>

        {attempt.skill_sha && (
          <>
            <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Skill SHA</dt>
            <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)", wordBreak: "break-all" }}>
              {attempt.skill_sha}
            </dd>
          </>
        )}

        {attempt.error_code && (
          <>
            <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Error code</dt>
            <dd style={{ margin: 0, color: "var(--aiq-color-danger)" }}>{attempt.error_code}</dd>
          </>
        )}

        {attempt.dedupe_dropped != null && attempt.dedupe_dropped > 0 && (
          <>
            <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Dedupe dropped</dt>
            <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>{attempt.dedupe_dropped}</dd>
          </>
        )}
      </dl>

      {attempt.error_message && (
        <div style={{ marginTop: "var(--aiq-space-sm)" }}>
          <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "0 0 4px" }}>
            Error message
          </p>
          <pre
            style={{
              margin: 0,
              padding: "var(--aiq-space-sm)",
              background: "var(--aiq-color-bg-base)",
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-sm)",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "10px",
              color: "var(--aiq-color-fg-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: "120px",
              overflowY: "auto",
            }}
          >
            {attempt.error_message}
          </pre>
        </div>
      )}

      {attempt.stderr_tail && (
        <div style={{ marginTop: "var(--aiq-space-sm)" }}>
          <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", margin: "0 0 4px" }}>
            stderr (last 1 024 bytes)
          </p>
          <pre
            style={{
              margin: 0,
              padding: "var(--aiq-space-sm)",
              background: "var(--aiq-color-bg-base)",
              border: "1px solid var(--aiq-color-border)",
              borderRadius: "var(--aiq-radius-sm)",
              fontFamily: "var(--aiq-font-mono)",
              fontSize: "10px",
              color: "var(--aiq-color-fg-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: "160px",
              overflowY: "auto",
            }}
          >
            {attempt.stderr_tail}
          </pre>
        </div>
      )}

      {/* Score this attempt — renders CLI command for ops to copy-run server-side */}
      <div style={{ marginTop: "var(--aiq-space-md)" }}>
        <p
          style={{
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-xs)",
            color: "var(--aiq-color-fg-muted)",
            margin: "0 0 6px",
          }}
        >
          Score this attempt — run on the VPS:
        </p>
        <pre
          style={{
            margin: 0,
            padding: "var(--aiq-space-sm) var(--aiq-space-md)",
            background: "var(--aiq-color-bg-base)",
            border: "1px solid var(--aiq-color-border)",
            borderRadius: "var(--aiq-radius-sm)",
            fontFamily: "var(--aiq-font-mono)",
            fontSize: "11px",
            color: "var(--aiq-color-fg-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            userSelect: "all",
          }}
        >
          {cliCommand}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AdminGenerationAttempts(): React.ReactElement {
  const [attempts, setAttempts] = useState<GenerationAttempt[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [statusFilter, setStatusFilter] = useState<GenerationAttemptStatus | "all">("all");
  const [packFilter, setPackFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>("all");

  // Pack list for name resolution (fetched once on mount)
  const [packs, setPacks] = useState<PackItem[]>([]);

  // Expanded row for details panel (attempt id)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const LIMIT = 50;

  // Fetch pack list once for name + level resolution
  useEffect(() => {
    adminApi<PacksResponse>("/admin/packs?pageSize=200")
      .then((r) => setPacks(r.items))
      .catch(() => {
        // Non-fatal — pack name column falls back to pack_id if resolution fails
      });
  }, []);

  const packById = (id: string): PackItem | undefined => packs.find((p) => p.id === id);

  const levelLabelById = (packId: string, levelId: string): string => {
    const pack = packById(packId);
    if (!pack?.levels) return levelId.slice(0, 8);
    const level = pack.levels.find((l) => l.id === levelId);
    return level?.label ?? levelId.slice(0, 8);
  };

  const fetchAttempts = useCallback(
    async (currentOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(LIMIT));
        params.set("offset", String(currentOffset));
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (packFilter !== "all") params.set("pack_id", packFilter);
        const since = dateRangeToSince(dateRange);
        if (since) params.set("since", since);

        const data = await adminApi<GenerationAttemptsResponse>(
          `/admin/generation-attempts?${params.toString()}`,
        );
        if (currentOffset === 0) {
          setAttempts(data.items);
        } else {
          setAttempts((prev) => [...prev, ...data.items]);
        }
        setTotal(data.total);
        setOffset(currentOffset);
      } catch (e) {
        const msg = e instanceof AdminApiError ? e.message : "Failed to load generation attempts";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, packFilter, dateRange],
  );

  // Reset and re-fetch when filters change
  useEffect(() => {
    setOffset(0);
    setAttempts([]);
    setExpandedId(null);
    void fetchAttempts(0);
  }, [fetchAttempts]);

  function handleLoadMore() {
    const nextOffset = offset + LIMIT;
    void fetchAttempts(nextOffset);
  }

  // ---------------------------------------------------------------------------
  // Chip helpers
  // ---------------------------------------------------------------------------

  const chipStyle = (active: boolean, fg?: string): React.CSSProperties => ({
    display: "inline-block",
    padding: "3px 12px",
    borderRadius: "var(--aiq-radius-full, 9999px)",
    border: `1px solid ${active ? (fg ?? "var(--aiq-color-accent)") : "var(--aiq-color-border)"}`,
    background: active ? (fg ? `${fg}18` : "var(--aiq-color-accent-soft)") : "transparent",
    color: active ? (fg ?? "var(--aiq-color-accent)") : "var(--aiq-color-fg-muted)",
    fontFamily: "var(--aiq-font-mono)",
    fontSize: "var(--aiq-text-xs)",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    userSelect: "none",
    transition: "border-color 0.12s, background 0.12s",
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasMore = attempts.length < total;

  return (
    <AdminShell breadcrumbs={["AI generation history"]}>
      {/* ── Page header ── */}
      <div style={{ padding: "var(--aiq-space-lg) var(--aiq-space-xl) var(--aiq-space-md)" }}>
        <h1
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-2xl)",
            fontWeight: 400,
            letterSpacing: "-0.02em",
            margin: "0 0 var(--aiq-space-xs)",
          }}
        >
          AI generation history
        </h1>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
          Every question-generation run across all packs. Read-only.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div
        style={{
          padding: "0 var(--aiq-space-xl) var(--aiq-space-md)",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--aiq-space-md)",
          alignItems: "center",
          borderBottom: "1px solid var(--aiq-color-border)",
        }}
      >
        {/* Status chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 4 }}>
            Status:
          </span>
          {(["all", "running", "success", "partial", "failed"] as const).map((s) => {
            const color = s === "all" ? undefined : STATUS_COLORS[s as GenerationAttemptStatus]?.fg;
            return (
              <button
                key={s}
                type="button"
                style={chipStyle(statusFilter === s, color)}
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All" : STATUS_COLORS[s as GenerationAttemptStatus].label}
              </button>
            );
          })}
        </div>

        {/* Pack picker */}
        {packs.length > 0 && (
          <div style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
            <label
              htmlFor="pack-picker"
              style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}
            >
              Pack:
            </label>
            <select
              id="pack-picker"
              value={packFilter}
              onChange={(e) => setPackFilter(e.target.value)}
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-xs)",
                padding: "3px 8px",
                border: "1px solid var(--aiq-color-border)",
                borderRadius: "var(--aiq-radius-sm)",
                background: "var(--aiq-color-bg-raised)",
                color: "var(--aiq-color-fg-primary)",
              }}
            >
              <option value="all">All packs</option>
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date range chips */}
        <div style={{ display: "flex", gap: "var(--aiq-space-xs)", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)", marginRight: 4 }}>
            Since:
          </span>
          {(["24h", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              style={chipStyle(dateRange === r)}
              onClick={() => setDateRange(r)}
            >
              {r === "all" ? "All time" : r === "24h" ? "Last 24h" : r === "7d" ? "Last 7d" : "Last 30d"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ padding: "0 var(--aiq-space-xl)", overflowX: "auto" }}>
        {error && (
          <div
            style={{
              margin: "var(--aiq-space-md) 0",
              padding: "var(--aiq-space-sm) var(--aiq-space-md)",
              background: "#fee2e2",
              border: "1px solid var(--aiq-color-danger)",
              borderRadius: "var(--aiq-radius-sm)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
              color: "var(--aiq-color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {!error && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-sm)",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--aiq-color-border)",
                  textAlign: "left",
                }}
              >
                {["Started", "Pack / Level", "Status", "Counts", "Duration", "Model", "Chunks", ""].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                      fontFamily: "var(--aiq-font-sans)",
                      fontSize: "var(--aiq-text-xs)",
                      fontWeight: 600,
                      color: "var(--aiq-color-fg-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && attempts.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: "var(--aiq-space-xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)" }}>
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && attempts.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: "var(--aiq-space-xl)", textAlign: "center", color: "var(--aiq-color-fg-muted)" }}>
                    No generation attempts found.
                  </td>
                </tr>
              )}
              {attempts.map((attempt) => {
                const isExpanded = expandedId === attempt.id;
                const pack = packById(attempt.pack_id);
                const packName = pack?.name ?? attempt.pack_id.slice(0, 8);
                const levelLabel = levelLabelById(attempt.pack_id, attempt.level_id);

                const hasChunks =
                  attempt.chunks_planned != null && attempt.chunks_planned > 0;
                const chunksLabel = hasChunks
                  ? `${attempt.chunks_planned}-${attempt.chunks_failed ?? 0}`
                  : "—";
                const chunksFailed = (attempt.chunks_failed ?? 0) > 0;

                const hasDetails =
                  attempt.error_code ||
                  attempt.error_message ||
                  attempt.stderr_tail ||
                  attempt.skill_sha;

                return (
                  <React.Fragment key={attempt.id}>
                    <tr
                      style={{
                        borderBottom: isExpanded ? "none" : "1px solid var(--aiq-color-border)",
                        background: isExpanded ? "var(--aiq-color-bg-raised)" : "transparent",
                        transition: "background 0.1s",
                      }}
                    >
                      {/* Started */}
                      <td
                        style={{
                          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-fg-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {attemptDate(attempt.started_at)}
                      </td>

                      {/* Pack / Level */}
                      <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)" }}>
                        <div style={{ fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>
                          {packName}
                        </div>
                        <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
                          {levelLabel}
                        </div>
                      </td>

                      {/* Status */}
                      <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", whiteSpace: "nowrap" }}>
                        <StatusPill status={attempt.status as GenerationAttemptStatus} />
                      </td>

                      {/* Counts: inserted/requested */}
                      <td
                        style={{
                          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-fg-secondary)",
                        }}
                      >
                        {attempt.count_inserted}/{attempt.count_requested}
                      </td>

                      {/* Duration */}
                      <td
                        style={{
                          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-fg-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {attempt.duration_ms != null ? formatDuration(attempt.duration_ms) : "—"}
                      </td>

                      {/* Model */}
                      <td
                        style={{
                          padding: "var(--aiq-space-sm) var(--aiq-space-md)",
                          fontFamily: "var(--aiq-font-mono)",
                          fontSize: "var(--aiq-text-xs)",
                          color: "var(--aiq-color-fg-secondary)",
                          maxWidth: "180px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {attempt.model ?? "—"}
                      </td>

                      {/* Chunks: planned-failed */}
                      <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)" }}>
                        <span
                          style={{
                            fontFamily: "var(--aiq-font-mono)",
                            fontSize: "var(--aiq-text-xs)",
                            color: chunksFailed ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-secondary)",
                          }}
                        >
                          {chunksLabel}
                        </span>
                      </td>

                      {/* Action */}
                      <td style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", textAlign: "right" }}>
                        {hasDetails && (
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : attempt.id)}
                            style={{
                              fontFamily: "var(--aiq-font-sans)",
                              fontSize: "var(--aiq-text-xs)",
                              color: "var(--aiq-color-accent)",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "2px 6px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {isExpanded ? "Hide ▴" : "Details ▸"}
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* Expanded details row */}
                    {isExpanded && (
                      <tr style={{ borderBottom: "1px solid var(--aiq-color-border)" }}>
                        <td
                          colSpan={8}
                          style={{ padding: 0 }}
                        >
                          <AttemptDetails
                            attempt={attempt}
                            packName={packName}
                            levelLabel={levelLabel}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── Pagination ── */}
        {!error && (
          <div
            style={{
              padding: "var(--aiq-space-md) 0 var(--aiq-space-xl)",
              display: "flex",
              alignItems: "center",
              gap: "var(--aiq-space-md)",
            }}
          >
            <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
              Showing {attempts.length} of {total}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loading}
                style={{
                  fontFamily: "var(--aiq-font-sans)",
                  fontSize: "var(--aiq-text-sm)",
                  padding: "4px 16px",
                  border: "1px solid var(--aiq-color-border)",
                  borderRadius: "var(--aiq-radius-sm)",
                  background: "var(--aiq-color-bg-raised)",
                  color: "var(--aiq-color-fg-primary)",
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
