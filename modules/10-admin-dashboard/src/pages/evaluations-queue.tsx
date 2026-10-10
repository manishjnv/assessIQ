// AssessIQ — Super-admin evaluation queue.
//
// /admin/platform/evaluations
//
// Every company's attempts that carry written answers and are waiting for
// AssessIQ to evaluate them (spec 2026-10-01 §11, wire contract §5b), oldest
// first. "Evaluate next" opens the oldest. Accepting the last grade of an
// attempt releases it to its company by itself (owner decision 2026-10-01), so
// the bulk "Release selected to company" is the RECOVERY action: finished (graded)
// attempts that are still here — sent back and re-evaluated, or completed before
// that change — can be released in bulk.
//
// Consumes:
//   GET  /api/admin/super/evaluations                          → { items, counts }
//   POST /api/admin/super/evaluations/release-to-tenant        → { released, skipped }
//
// INVARIANTS:
//  - Blind evaluation: rows carry NO candidate name or email, and neither does
//    this page. Answer text is never listed here.
//  - Polls every 30 s (silent — no loading flicker), same cadence as the
//    dashboard grading queue.
//  - No claude/anthropic imports.
//
// Diverges from screens/dashboard.jsx because: the kit has no queue screen; this
// reuses the dashboard's page-header + StatCard row + Table idiom (the admin
// dashboard queue is the closest recipe) rather than inventing a layout.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip, Icon, StatCard, Table } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { AdminShell } from "../components/AdminShell.js";
import { useMfaGuard } from "../components/useMfaGuard.js";
import { adminApi, getReadiness } from "../api.js";
import { ageLabel, ageTone, apiMessage } from "../lib/evaluation.js";
import { formatTimestamp } from "../lib/format.js";

interface EvaluationRow {
  attempt_id: string;
  tenant_id: string;
  tenant_name: string;
  assessment_id: string;
  assessment_name: string;
  level_label: string;
  submitted_at: string | null;
  /** Hours since submit, 1 dp. */
  age_hours: number;
  written_count: number;
  kql_count: number;
  status: string;
  /** Every question has a final grade (status 'graded') — ready to release. */
  complete: boolean;
  grading_in_progress: boolean;
  sent_back: boolean;
  sent_back_note: string | null;
  /** FU-A11: the company turned AI evaluation off; grade / rerun answer 409, manual score still works. */
  ai_paused?: boolean;
}

interface EvaluationsResponse {
  items: EvaluationRow[];
  counts?: { pending: number; older_than_24h: number };
}

interface ReleaseResult {
  released: string[];
  skipped: Array<{ id: string; code: string }>;
}

interface EvalGateStatus {
  mode: "off" | "warn" | "enforce";
  approved: boolean;
}

interface GradingQualityRow {
  prompt_version_sha: string;
  ai_grades: number;
  overrides: number;
  override_rate: number | null;
  mean_abs_band_delta: number | null;
  mean_abs_score_delta_pct: number | null;
}

const DETAIL_PATH = "/admin/platform/evaluations";

const MONO_LABEL: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--aiq-color-fg-muted)",
};

const ELLIPSIS: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

/** Age pill: neutral under 24 h, amber from 24 h, red from 48 h (icon + text, never colour alone). */
function AgeBadge({ hours }: { hours: number }): React.ReactElement {
  const tone = ageTone(hours);
  const palette = {
    ok: { bg: "var(--aiq-color-bg-sunken)", fg: "var(--aiq-color-fg-secondary)", border: "var(--aiq-color-border)", hint: "Waiting less than 24 hours" },
    warn: { bg: "var(--aiq-color-warning-soft, #fff8e0)", fg: "var(--aiq-color-warning, #b08000)", border: "var(--aiq-color-warning, #b08000)", hint: "Waiting more than 24 hours" },
    late: { bg: "var(--aiq-color-danger-subtle, #fff0f0)", fg: "var(--aiq-color-danger)", border: "var(--aiq-color-danger)", hint: "Waiting more than 48 hours" },
  }[tone];
  return (
    <span
      data-help-id="admin.evaluations.queue.age_badge"
      data-age-tone={tone}
      title={palette.hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--aiq-font-mono)",
        fontSize: "var(--aiq-text-xs)",
        padding: "1px 8px",
        borderRadius: "var(--aiq-radius-pill)",
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
      }}
    >
      {tone !== "ok" && <Icon name="flag" size={10} aria-hidden />}
      {ageLabel(hours)}
    </span>
  );
}

type Readiness = { checks?: Record<string, boolean> } | "loading" | "unknown";

// RW-9: one fetch on mount. /api/ready answers 503 with a JSON body when a
// check fails, so the body is data here, not an error (adminApi would throw).
function RuntimeStatusChip(): React.ReactElement {
  const [r, setR] = useState<Readiness>("loading");
  useEffect(() => {
    let live = true;
    getReadiness()
      .then((b) => live && setR(b))
      .catch(() => live && setR("unknown"));
    return () => {
      live = false;
    };
  }, []);
  const failed = typeof r === "object" ? Object.entries(r.checks ?? {}).filter(([, v]) => !v).map(([k]) => k) : [];
  const ready = typeof r === "object" && r.checks !== undefined && failed.length === 0;
  const label =
    r === "loading" ? "Checking…" : r === "unknown" ? "Not ready: unknown" : ready ? "AI runtime ready" : `Not ready: ${failed.join(", ") || "unknown"}`;
  return (
    <span data-help-id="admin.evaluations.queue.runtime_status">
      <Chip variant={ready ? "success" : r === "loading" ? "default" : "warn"}>{label}</Chip>
    </span>
  );
}

function StatusCell({ row }: { row: EvaluationRow }): React.ReactElement {
  const s = row.complete
    ? { label: "Ready to send", variant: "success" as const }
    : row.grading_in_progress
      ? { label: "Grading…", variant: "accent" as const }
      : { label: "Awaiting grading", variant: "accent" as const };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <Chip variant={s.variant}>{s.label}</Chip>
      {row.ai_paused === true && (
        <span data-help-id="admin.evaluations.queue.ai_paused" title="The organisation turned AI grading off. Score manually or ask the organisation to turn it on.">
          <Chip variant="warn">AI paused</Chip>
        </span>
      )}
      {row.sent_back && (
        <span
          data-help-id="admin.evaluations.queue.sent_back"
          title={row.sent_back_note ?? "Sent back by the organisation"}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}
        >
          <Chip variant="warn">Sent back</Chip>
          {row.sent_back_note && (
            <span style={{ ...ELLIPSIS, fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-secondary)" }}>
              {row.sent_back_note}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** Extra read-only info (eval gate banner + prompt quality); failures here never block the queue. */
function useQuietFetch<T>(path: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    adminApi<T>(path)
      .then((d) => live && setData(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [path]);
  return data;
}

function EvalGateBanner({ gate }: { gate: EvalGateStatus | null }): React.ReactElement | null {
  if (!gate || gate.approved || gate.mode === "off") return null;
  return (
    <div
      role="alert"
      data-help-id="admin.evaluations.queue.eval_gate"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "var(--aiq-space-sm) var(--aiq-space-md)",
        border: "1px solid var(--aiq-color-warning, #b08000)",
        borderRadius: "var(--aiq-radius-md)",
        background: "var(--aiq-color-warning-soft, #fff8e0)",
        fontSize: "var(--aiq-text-sm)",
      }}
    >
      <Icon name="flag" size={14} aria-hidden />
      {gate.mode === "enforce"
        ? "AI grading is blocked: prompts changed since the last passing eval."
        : "Prompts are not eval-approved yet."}
    </div>
  );
}

function GradingQualityCard({ rows }: { rows: GradingQualityRow[] | null }): React.ReactElement | null {
  if (!rows) return null;
  const pct = (v: number | null): string => (v === null ? "–" : `${Math.round(v * 1000) / 10}%`);
  const num = (v: number | null, suffix = ""): string => (v === null ? "–" : `${v}${suffix}`);
  const columns: ColumnDef<GradingQualityRow>[] = [
    {
      key: "prompt_version_sha",
      label: "Prompt version",
      width: "minmax(220px, 2fr)",
      render: (r) => <span style={{ ...ELLIPSIS, fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>{r.prompt_version_sha}</span>,
    },
    { key: "ai_grades", label: "AI grades", width: 96 },
    { key: "overrides", label: "Overrides", width: 96 },
    { key: "override_rate", label: "Override rate", width: 120, render: (r) => pct(r.override_rate) },
    { key: "mean_abs_band_delta", label: "Score band change", width: 110, render: (r) => num(r.mean_abs_band_delta) },
    { key: "mean_abs_score_delta_pct", label: "Score change", width: 120, render: (r) => num(r.mean_abs_score_delta_pct, "%") },
  ];
  return (
    <div className="aiq-card" data-density="compact" data-help-id="admin.evaluations.queue.grading_quality" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "var(--aiq-space-sm) var(--aiq-space-md)", ...MONO_LABEL }}>AI grading quality · last 90 days</div>
      <div className="aiq-admin-table-scroll">
        <Table<GradingQualityRow> data={rows} columns={columns} emptyMessage="No grades." />
      </div>
    </div>
  );
}

export function AdminEvaluationsQueue(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<EvaluationRow[]>([]);
  const [serverCounts, setServerCounts] = useState<EvaluationsResponse["counts"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenantFilter, setTenantFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [releasing, setReleasing] = useState(false);
  const [releaseResult, setReleaseResult] = useState<ReleaseResult | null>(null);
  const evalGate = useQuietFetch<EvalGateStatus>("/admin/super/eval-gate");
  const quality = useQuietFetch<{ items: GradingQualityRow[] }>("/admin/super/grading-quality?days=90");
  const { guard, stepUp } = useMfaGuard(
    "Sending to organisations needs a fresh authenticator check. Enter your 6-digit code to continue.",
  );

  const fetchQueue = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      const data = await adminApi<EvaluationsResponse>("/admin/super/evaluations");
      setItems(data.items);
      setServerCounts(data.counts ?? null);
      setError(null);
    } catch (err) {
      setError(apiMessage(err, "Failed to load the grading queue."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchQueue(false);
    // Short-poll every 30 s (silent), as the dashboard queue does.
    const interval = setInterval(() => void fetchQueue(true), 30_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // Company filter options come from what is in the queue right now.
  const tenants = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of items) byId.set(r.tenant_id, r.tenant_name);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  useEffect(() => {
    if (tenantFilter && !tenants.some((t) => t.id === tenantFilter)) setTenantFilter("");
  }, [tenants, tenantFilter]);

  const rows = useMemo(
    () => (tenantFilter ? items.filter((r) => r.tenant_id === tenantFilter) : items),
    [items, tenantFilter],
  );

  // The server's counts describe the whole queue; a company filter recounts locally.
  const pendingCount = !tenantFilter && serverCounts ? serverCounts.pending : rows.length;
  const olderCount =
    !tenantFilter && serverCounts ? serverCounts.older_than_24h : rows.filter((r) => r.age_hours >= 24).length;

  // Only finished (complete) rows can be released; drop selections that no longer qualify.
  const chosen = useMemo(() => {
    const ok = new Set(items.filter((r) => r.complete).map((r) => r.attempt_id));
    return [...selected].filter((id) => ok.has(id));
  }, [items, selected]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleReleaseSelected(): Promise<void> {
    if (chosen.length === 0) return;
    setReleasing(true);
    setReleaseResult(null);
    await guard(
      async () => {
        const res = await adminApi<ReleaseResult>("/admin/super/evaluations/release-to-tenant", {
          method: "POST",
          body: JSON.stringify({ attempt_ids: chosen }),
        });
        setReleaseResult(res);
        setSelected(new Set());
        await fetchQueue(true);
      },
      (message) => setError(message),
    );
    setReleasing(false);
  }

  const columns: ColumnDef<EvaluationRow>[] = [
    {
      key: "tenant_name",
      label: "Organisation",
      width: "minmax(170px, 1.2fr)",
      render: (row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <input
            type="checkbox"
            aria-label={`Select ${row.assessment_name} for sending`}
            disabled={!row.complete}
            title={row.complete ? undefined : "Finish grading before sending"}
            checked={chosen.includes(row.attempt_id)}
            onChange={() => toggle(row.attempt_id)}
            style={{ accentColor: "var(--aiq-color-accent)", flexShrink: 0 }}
          />
          <span style={ELLIPSIS}>{row.tenant_name}</span>
        </span>
      ),
    },
    {
      key: "assessment_name",
      label: "Assessment",
      width: "minmax(170px, 1.4fr)",
      render: (row) => <span style={ELLIPSIS}>{row.assessment_name}</span>,
    },
    { key: "level_label", label: "Difficulty", width: 80 },
    {
      key: "submitted_at",
      label: "Submitted",
      width: 160,
      render: (row) => (
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", color: "var(--aiq-color-fg-muted)" }}>
          {formatTimestamp(row.submitted_at)}
        </span>
      ),
    },
    { key: "age_hours", label: "Age", width: 96, render: (row) => <AgeBadge hours={row.age_hours} /> },
    {
      key: "written_count",
      label: "Answers",
      width: 140,
      render: (row) => (
        <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)" }}>
          {row.written_count} written{row.kql_count > 0 ? ` · ${row.kql_count} KQL` : ""}
        </span>
      ),
    },
    { key: "status", label: "Status", width: "minmax(210px, 1.4fr)", render: (row) => <StatusCell row={row} /> },
    {
      key: "action",
      label: "",
      width: 104,
      render: (row) => (
        <button
          type="button"
          className="aiq-btn aiq-btn-outline aiq-btn-sm"
          onClick={() => navigate(`${DETAIL_PATH}/${row.attempt_id}`)}
        >
          Grade
        </button>
      ),
    },
  ];

  // FU-A11: "Evaluate next" skips paused companies (their AI runs answer 409).
  const oldest = rows.find((r) => r.ai_paused !== true);

  return (
    <AdminShell
      breadcrumbs={[{ label: "Platform", href: "/admin/platform" }, "Grading queue"]}
      helpPage="admin.evaluations.queue"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{pendingCount} in queue</Chip>{" "}
            <RuntimeStatusChip />
          </div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Grading queue.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Written answers from every organisation, oldest first. Accepting the last grade of an attempt sends it to its organisation and takes it off this list.
          </p>
        </div>

        <EvalGateBanner gate={evalGate} />

        {/* Counts */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--aiq-space-md)", maxWidth: 560 }}>
          <StatCard label="In queue" value={pendingCount} />
          <StatCard label="Older than 24 h" value={olderCount} />
        </div>

        {/* Toolbar */}
        <div className="aiq-admin-filter-strip" style={{ alignItems: "center", gap: "var(--aiq-space-md)", borderBottom: "1px solid var(--aiq-color-border)", paddingBottom: "var(--aiq-space-sm)" }}>
          <label data-help-id="admin.evaluations.queue.tenant_filter" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={MONO_LABEL}>Organisation</span>
            <select
              className="aiq-input"
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">All organisations</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="aiq-btn aiq-btn-outline"
            data-help-id="admin.evaluations.queue.release_selected"
            disabled={chosen.length === 0 || releasing}
            onClick={() => void handleReleaseSelected()}
          >
            {releasing ? "Sending…" : `Send selected to organisation${chosen.length > 0 ? ` (${chosen.length})` : ""}`}
          </button>
          <button
            type="button"
            className="aiq-btn aiq-btn-primary"
            data-help-id="admin.evaluations.queue.evaluate_next"
            disabled={!oldest}
            onClick={() => oldest && navigate(`${DETAIL_PATH}/${oldest.attempt_id}`)}
          >
            Grade next
          </button>
        </div>

        {releaseResult && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            <Chip variant="success">
              Sent {releaseResult.released.length} to {releaseResult.released.length === 1 ? "its organisation" : "their organisations"}
            </Chip>
            {releaseResult.skipped.length > 0 && (
              <Chip variant="warn">
                Skipped {releaseResult.skipped.length}: {[...new Set(releaseResult.skipped.map((s) => s.code))].join(", ")}
              </Chip>
            )}
          </div>
        )}

        {error && (
          <div role="alert" style={{ color: "var(--aiq-color-danger)", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            {error}
          </div>
        )}

        <div className="aiq-card" data-density="compact" data-help-id="admin.evaluations.queue.overview" style={{ padding: 0, overflow: "hidden" }}>
          <div className="aiq-admin-table-scroll">
            {!loading && rows.length === 0 && !error ? (
              <div style={{ padding: "var(--aiq-space-3xl) var(--aiq-space-lg)", textAlign: "center" }}>
                <p style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: "0 0 var(--aiq-space-sm)", letterSpacing: "-0.015em" }}>
                  The queue is clear.
                </p>
                <p style={{ fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)", margin: "0 auto", maxWidth: 360 }}>
                  New submissions with written answers will appear here.
                </p>
              </div>
            ) : (
              <Table<EvaluationRow>
                data={rows}
                columns={columns}
                loading={loading}
                emptyMessage="No grades in queue."
              />
            )}
          </div>
        </div>

        <GradingQualityCard rows={quality?.items ?? null} />
      </div>

      {stepUp}
    </AdminShell>
  );
}
