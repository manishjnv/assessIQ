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
//  - No new dependency — uses ui-system format helpers
//    (same pattern as pack-detail.tsx).
//  - Filter state is client-side React state; no URL params, no localStorage.
//  - stderr_tail rendered in <pre> with max-height + overflow-auto.
//  - No claude/anthropic imports or copy.

import { generationStatusLabel, questionTypeLabel } from "../lib/labels.js";
import React, { useEffect, useState, useCallback } from "react";
import { Chip, Table, formatRelative, formatDateTime } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError, scoreGenerationAttempt } from "../api.js";
import type { ScoreAttemptResponse } from "../api.js";

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
  citation_dropped: number | null;
  difficulty_dropped: number | null;
  level_label: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  pack_id: string;
  level_id: string;
  user_id: string | null;
  batch_id: string | null;
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
  return Date.now() - new Date(isoStr).getTime() < 30 * 60_000 ? formatRelative(isoStr) : formatDateTime(isoStr);
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
  const { bg, fg } = STATUS_COLORS[status] ?? STATUS_COLORS.failed;
  const label = generationStatusLabel(status);
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
// Verdict pill
// ---------------------------------------------------------------------------

const VERDICT_STYLES: Record<
  "pass" | "regression" | "warning" | "n/a",
  { bg: string; fg: string; label: string }
> = {
  pass:       { bg: "var(--aiq-color-success-soft)", fg: "var(--aiq-color-success)",           label: "Pass"              },
  regression: { bg: "#fee2e2",                        fg: "var(--aiq-color-danger)",             label: "Regression"        },
  warning:    { bg: "#fef3c7",                        fg: "var(--aiq-color-warning, #d97706)",   label: "Warning"           },
  "n/a":      { bg: "var(--aiq-color-bg-raised)",    fg: "var(--aiq-color-fg-muted)",           label: "Insufficient data" },
};

function VerdictPill({ verdict }: { verdict: "pass" | "regression" | "warning" | "n/a" }): React.ReactElement {
  const { bg, fg, label } = VERDICT_STYLES[verdict] ?? VERDICT_STYLES["n/a"];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "var(--aiq-radius-full, 9999px)",
        background: bg,
        color: fg,
        fontFamily: "var(--aiq-font-sans)",
        fontSize: "var(--aiq-text-xs)",
        fontWeight: 700,
        letterSpacing: "0.03em",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Score result block — rendered below attempt metadata after button click
// ---------------------------------------------------------------------------

function ScoreResultBlock({ result }: { result: ScoreAttemptResponse }): React.ReactElement {
  const ALL_TYPES = ["mcq", "kql", "subjective", "log_analysis", "scenario"] as const;
  const typeMap = new Map(result.structural.per_type.map((r) => [r.type, r]));

  // The five AI-generated types always show (zero rows when absent); any other
  // type the server returns also shows, after them in server order.
  const allTypes: string[] = [...new Set<string>([...ALL_TYPES, ...result.structural.per_type.map((r) => r.type)])];
  const rows = allTypes.map((t) => typeMap.get(t) ?? { type: t, total: 0, passed: 0, failed: 0, failures: [] });

  return (
    <div style={{ marginTop: "var(--aiq-space-md)" }}>
      {/* Overall verdict */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", marginBottom: "var(--aiq-space-sm)" }}>
        <HelpTip helpId="admin.gen_score.verdict">
          <span style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
            Overall verdict:
          </span>
        </HelpTip>
        <VerdictPill verdict={result.overall} />
      </div>

      {/* Structural quality table */}
      <p
        style={{
          fontFamily: "var(--aiq-font-sans)",
          fontSize: "var(--aiq-text-xs)",
          fontWeight: 600,
          color: "var(--aiq-color-fg-secondary)",
          margin: "0 0 4px",
        }}
      >
        <HelpTip helpId="admin.gen_score.structural">
          <span>Structural quality</span>
        </HelpTip>
      </p>
      <div style={{ overflowX: "auto" }}>
        <Table<(typeof rows)[number]>
          data={rows}
          columns={[
            { key: "type", label: "type", render: (row) => questionTypeLabel(row.type) },
            { key: "total", label: "total", render: (row) => row.total },
            { key: "passed", label: "passed", render: (row) => <span style={{ color: row.failed > 0 ? "var(--aiq-color-fg-secondary)" : "var(--aiq-color-success)" }}>{row.passed}</span> },
            { key: "failed", label: "failed", render: (row) => <span style={{ color: row.failed > 0 ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-secondary)" }}>{row.failed}</span> },
            { key: "reasons", label: "reasons", width: "minmax(0, 2fr)", render: (row) => (row.failures.length > 0 ? row.failures.slice(0, 3).join("; ") : "—") },
          ]}
        />
      </div>
      <p style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "10px", color: "var(--aiq-color-fg-muted)", margin: "4px 0 0" }}>
        Total: {result.structural.passed}/{result.structural.total} passed.{" "}
        Baseline regressions: {result.structural.baseline_diff.regressions.length}.
      </p>

      {/* Runtime metrics table — only when thresholds are available */}
      {result.runtime.metrics.length > 0 && (
        <>
          <p
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-xs)",
              fontWeight: 600,
              color: "var(--aiq-color-fg-secondary)",
              margin: "var(--aiq-space-sm) 0 4px",
            }}
          >
            <HelpTip helpId="admin.gen_score.runtime">
              <span>Runtime metrics</span>
            </HelpTip>
          </p>
          <div style={{ overflowX: "auto" }}>
            <Table<ScoreAttemptResponse["runtime"]["metrics"][number]>
              data={result.runtime.metrics}
              columns={[
                { key: "name", label: "metric", render: (m) => m.name },
                { key: "value", label: "value", render: (m) => (m.value !== null ? m.value.toFixed(2) : "n/a") },
                { key: "threshold", label: "threshold", render: (m) => m.threshold },
                {
                  key: "verdict",
                  label: "verdict",
                  render: (m) => (
                    <span style={{ color: m.verdict === "pass" ? "var(--aiq-color-success)" : m.verdict === "fail" ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-muted)", fontWeight: 600 }}>
                      {m.verdict === "pass" ? "✓ pass" : m.verdict === "fail" ? "✗ fail" : "n/a"}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row expansion — details panel
// ---------------------------------------------------------------------------

function AttemptDetails({ attempt, packName, levelLabel, scoreResult, scoreLoading, scoreError, onScore }: {
  attempt: GenerationAttempt;
  packName: string;
  levelLabel: string;
  scoreResult: ScoreAttemptResponse | null;
  scoreLoading: boolean;
  scoreError: string | null;
  onScore: () => void;
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

        <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Question set / difficulty</dt>
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

        {attempt.citation_dropped != null && attempt.citation_dropped > 0 && (
          <>
            <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Citation dropped</dt>
            <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>{attempt.citation_dropped}</dd>
          </>
        )}

        {attempt.difficulty_dropped != null && attempt.difficulty_dropped > 0 && (
          <>
            <dt style={{ color: "var(--aiq-color-fg-muted)" }}>Difficulty dropped</dt>
            <dd style={{ margin: 0, color: "var(--aiq-color-fg-secondary)" }}>{attempt.difficulty_dropped}</dd>
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

      {/* Score this attempt — in-app button that calls the server-side scorer */}
      <div style={{ marginTop: "var(--aiq-space-md)" }}>
        {/* Primary action: Score this attempt */}
        <HelpTip helpId="admin.gen_score.score_button">
        <button
          type="button"
          disabled={scoreLoading}
          onClick={onScore}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "var(--aiq-font-sans)",
            fontSize: "var(--aiq-text-sm)",
            fontWeight: 600,
            padding: "5px 14px",
            borderRadius: "var(--aiq-radius-sm)",
            background: scoreLoading ? "var(--aiq-color-bg-raised)" : "var(--aiq-color-accent)",
            color: scoreLoading ? "var(--aiq-color-fg-muted)" : "#fff",
            border: "none",
            cursor: scoreLoading ? "not-allowed" : "pointer",
            opacity: scoreLoading ? 0.7 : 1,
            transition: "opacity 0.1s",
          }}
        >
          {scoreLoading && (
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "12px",
                border: "2px solid currentColor",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "spin 0.6s linear infinite",
              }}
            />
          )}
          {scoreLoading ? "Scoring…" : "Score this attempt"}
        </button>
        </HelpTip>

        {/* Error state */}
        {scoreError && (
          <div
            style={{
              marginTop: "var(--aiq-space-sm)",
              padding: "var(--aiq-space-xs) var(--aiq-space-sm)",
              background: "#fee2e2",
              border: "1px solid var(--aiq-color-danger)",
              borderRadius: "var(--aiq-radius-sm)",
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-xs)",
              color: "var(--aiq-color-danger)",
              display: "flex",
              alignItems: "center",
              gap: "var(--aiq-space-sm)",
            }}
          >
            <span>Could not score this attempt: {scoreError}</span>
            <button
              type="button"
              onClick={onScore}
              style={{
                fontFamily: "var(--aiq-font-sans)",
                fontSize: "var(--aiq-text-xs)",
                color: "var(--aiq-color-danger)",
                background: "none",
                border: "1px solid currentColor",
                borderRadius: "var(--aiq-radius-sm)",
                cursor: "pointer",
                padding: "1px 8px",
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Score result tables */}
        {scoreResult && <ScoreResultBlock result={scoreResult} />}

        {/* Footnote: CLI command for deeper diagnostics (ops only) */}
        <div style={{ marginTop: "var(--aiq-space-md)" }}>
          <p
            style={{
              fontFamily: "var(--aiq-font-sans)",
              fontSize: "var(--aiq-text-xs)",
              color: "var(--aiq-color-fg-muted)",
              margin: "0 0 4px",
            }}
          >
            For deeper diagnostics, run on the VPS:
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
              color: "var(--aiq-color-fg-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {cliCommand}
          </pre>
        </div>
      </div>

      {/* Spinner keyframe — injected once via a style tag */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attempts table model: one Table row per singleton, batch summary, or batch child
// ---------------------------------------------------------------------------

type AttemptRow =
  | { kind: "single" | "child"; key: string; attempt: GenerationAttempt; packName: string }
  | { kind: "group"; key: string; members: GenerationAttempt[]; packName: string };

const MONO: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  color: "var(--aiq-color-fg-secondary)",
};

function hasDetails(a: GenerationAttempt): boolean {
  return Boolean(
    a.error_code ||
      a.error_message ||
      a.stderr_tail ||
      a.skill_sha ||
      (a.dedupe_dropped ?? 0) > 0 ||
      (a.citation_dropped ?? 0) > 0 ||
      (a.difficulty_dropped ?? 0) > 0,
  );
}

// Rollup status for a batch group.
function rollupStatus(members: GenerationAttempt[]): GenerationAttemptStatus {
  if (members.some((m) => m.status === "running")) return "running";
  if (members.some((m) => m.status === "failed" || m.status === "partial")) return "partial";
  return "success";
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

  // Sort state
  const [sortBy, setSortBy] = useState<string>("started_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Pack list for name resolution (fetched once on mount)
  const [packs, setPacks] = useState<PackItem[]>([]);

  // Expanded row for details panel (attempt id) — also used for singleton rows.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Expanded batch group (batch_id string) — controls the child-rows accordion.
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  // Score state — cached per attempt id so re-expanding doesn't re-fetch.
  // scoreResultMap: attemptId → ScoreAttemptResponse | null (null = not yet scored)
  // scoreLoadingId: the attempt id currently being scored (only one in-flight at a time)
  // scoreErrorMap: attemptId → error message string
  const [scoreResultMap, setScoreResultMap] = useState<Map<string, ScoreAttemptResponse>>(new Map());
  const [scoreLoadingId, setScoreLoadingId] = useState<string | null>(null);
  const [scoreErrorMap, setScoreErrorMap] = useState<Map<string, string>>(new Map());

  const handleScore = useCallback(async (attemptId: string) => {
    setScoreLoadingId(attemptId);
    setScoreErrorMap((prev) => {
      const next = new Map(prev);
      next.delete(attemptId);
      return next;
    });
    try {
      const result = await scoreGenerationAttempt(attemptId);
      setScoreResultMap((prev) => new Map(prev).set(attemptId, result));
    } catch (e) {
      const msg = e instanceof AdminApiError ? e.message : "Scoring failed";
      setScoreErrorMap((prev) => new Map(prev).set(attemptId, msg));
    } finally {
      setScoreLoadingId(null);
    }
  }, []);

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
    if (!pack?.levels) return "Unknown difficulty";
    const level = pack.levels.find((l) => l.id === levelId);
    return level?.label ?? "Unknown difficulty";
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
        params.set("sort", sortBy);
        params.set("dir", sortDir);

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
    [statusFilter, packFilter, dateRange, sortBy, sortDir],
  );

  // Reset and re-fetch when filters change
  useEffect(() => {
    setOffset(0);
    setAttempts([]);
    setExpandedId(null);
    setExpandedGroupId(null);
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

  const levelOf = (a: GenerationAttempt): string => a.level_label ?? levelLabelById(a.pack_id, a.level_id);

  // ---------------------------------------------------------------------------
  // Batch grouping — display-only, no API changes.
  //
  // Attempts with the same non-null batch_id form one group; batch_id === null
  // is a singleton. Group order = first appearance in the already-sorted
  // `attempts` array (Map keeps insertion order). A multi-member group renders
  // a summary row, plus one child row per member while the group is open.
  // ---------------------------------------------------------------------------
  const groupMap = new Map<string, GenerationAttempt[]>();
  for (const a of attempts) {
    const k = a.batch_id ?? a.id;
    const g = groupMap.get(k);
    if (g) g.push(a);
    else groupMap.set(k, [a]);
  }
  const tableRows: AttemptRow[] = [];
  for (const [key, members] of groupMap) {
    const first = members[0]!;
    const packName = packById(first.pack_id)?.name ?? "Unknown question set";
    if (members.length === 1) {
      tableRows.push({ kind: "single", key: first.id, attempt: first, packName });
      continue;
    }
    tableRows.push({ kind: "group", key, members, packName });
    if (expandedGroupId === key) {
      for (const a of members) tableRows.push({ kind: "child", key: a.id, attempt: a, packName });
    }
  }

  const rowStyleFor = (r: AttemptRow): React.CSSProperties => {
    const open = r.kind === "group" ? expandedGroupId === r.key : expandedId === r.key;
    if (open) return { borderBottom: "none", background: "var(--aiq-color-bg-raised)" };
    return r.kind === "child" ? { background: "var(--aiq-color-bg-sunken)" } : {};
  };

  const toggleButton = (open: boolean, closedLabel: string, onClick: () => void) => (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      style={{ marginLeft: "auto", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-accent)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", whiteSpace: "nowrap" }}
    >
      {open ? "Hide ▴" : closedLabel}
    </button>
  );

  const attemptColumns: ColumnDef<AttemptRow>[] = [
    {
      key: "started_at",
      label: "Started",
      sortable: true,
      width: 150,
      render: (r) =>
        r.kind === "group" ? (
          <span style={MONO}>
            {attemptDate(r.members.reduce((min, m) => (m.started_at < min ? m.started_at : min), r.members[0]!.started_at))}
          </span>
        ) : (
          <span style={r.kind === "child" ? { ...MONO, color: "var(--aiq-color-fg-muted)", paddingLeft: "var(--aiq-space-md)" } : MONO}>
            {attemptDate(r.attempt.started_at)}
          </span>
        ),
    },
    {
      key: "pack",
      label: "Question set / difficulty",
      width: "minmax(160px, 2fr)",
      render: (r) => {
        const level = (
          <div style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
            {levelOf(r.kind === "group" ? r.members[0]! : r.attempt)}
          </div>
        );
        if (r.kind === "child") return level;
        return (
          <div style={{ minWidth: 0, fontSize: "var(--aiq-text-sm)" }}>
            <div style={{ fontWeight: 500, color: "var(--aiq-color-fg-primary)" }}>{r.packName}</div>
            {level}
          </div>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      width: 110,
      render: (r) => <StatusPill status={r.kind === "group" ? rollupStatus(r.members) : r.attempt.status} />,
    },
    {
      key: "counts",
      label: "Counts",
      width: 80,
      render: (r) =>
        r.kind === "group" ? (
          <span style={MONO}>
            {r.members.reduce((s, m) => s + m.count_inserted, 0)}/{r.members.reduce((s, m) => s + m.count_requested, 0)}
          </span>
        ) : (
          <span style={MONO}>{r.attempt.count_inserted}/{r.attempt.count_requested}</span>
        ),
    },
    {
      key: "duration_ms",
      label: "Duration",
      sortable: true,
      width: 90,
      render: (r) => {
        if (r.kind === "group") {
          const ms = r.members.reduce((s, m) => s + (m.duration_ms ?? 0), 0);
          return <span style={MONO}>{ms > 0 ? formatDuration(ms) : "—"}</span>;
        }
        return <span style={MONO}>{r.attempt.duration_ms != null ? formatDuration(r.attempt.duration_ms) : "—"}</span>;
      },
    },
    {
      key: "model",
      label: "Model",
      sortable: true,
      width: "minmax(0, 1fr)",
      render: (r) => (
        <span style={{ ...MONO, overflow: "hidden", textOverflow: "ellipsis" }}>
          {(r.kind === "group" ? r.members.find((m) => m.model != null)?.model : r.attempt.model) ?? "—"}
        </span>
      ),
    },
    {
      key: "chunks",
      label: "Chunks",
      width: 80,
      render: (r) => {
        if (r.kind === "group") return <span style={MONO}>{r.members.length} runs</span>;
        const a = r.attempt;
        const hasChunks = a.chunks_planned != null && a.chunks_planned > 0;
        const failed = (a.chunks_failed ?? 0) > 0;
        return (
          <span style={{ ...MONO, color: failed ? "var(--aiq-color-danger)" : "var(--aiq-color-fg-secondary)" }}>
            {hasChunks ? `${a.chunks_planned}-${a.chunks_failed ?? 0}` : "—"}
          </span>
        );
      },
    },
    {
      key: "action",
      label: "",
      width: 110,
      render: (r) => {
        if (r.kind === "group") {
          const open = expandedGroupId === r.key;
          return toggleButton(open, `${r.members.length} cats ▸`, () => setExpandedGroupId(open ? null : r.key));
        }
        if (!hasDetails(r.attempt)) return null;
        const open = expandedId === r.key;
        return toggleButton(open, "Details ▸", () => setExpandedId(open ? null : r.key));
      },
    },
  ];

  return (
    <AdminShell breadcrumbs={["AI generation history"]} helpPage="admin.gen_score">
      {/* ── Page header ── */}
      <div style={{ padding: "var(--aiq-space-lg) var(--aiq-space-xl) var(--aiq-space-md)" }}>
        <div style={{ marginBottom: 12 }}>
          <Chip leftIcon="grid">{total} attempt{total !== 1 ? "s" : ""}</Chip>
        </div>
        <h1
          data-help-id="admin.gen_score.history"
          style={{
            fontFamily: "var(--aiq-font-serif)",
            fontSize: "var(--aiq-text-3xl)",
            fontWeight: 400,
            letterSpacing: "-0.02em",
            margin: "0 0 var(--aiq-space-xs)",
          }}
        >
          AI generation history.
        </h1>
        <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)", margin: 0 }}>
          Every question-generation run across all packs. Read-only.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div
        className="aiq-admin-filter-strip"
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
                {s === "all" ? "All" : generationStatusLabel(s)}
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
              Question set:
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
              <option value="all">All question sets</option>
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
          <Table<AttemptRow>
            data={tableRows}
            columns={attemptColumns}
            rowKey={(r) => r.key}
            expandedId={expandedId}
            rowStyle={rowStyleFor}
            renderExpanded={(r) =>
              r.kind === "group" ? null : (
                <AttemptDetails
                  attempt={r.attempt}
                  packName={r.packName}
                  levelLabel={levelOf(r.attempt)}
                  scoreResult={scoreResultMap.get(r.attempt.id) ?? null}
                  scoreLoading={scoreLoadingId === r.attempt.id}
                  scoreError={scoreErrorMap.get(r.attempt.id) ?? null}
                  onScore={() => { void handleScore(r.attempt.id); }}
                />
              )
            }
            loading={loading && attempts.length === 0}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={(key, dir) => { setSortBy(key); setSortDir(dir); }}
            emptyMessage="No generation attempts found."
          />
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
