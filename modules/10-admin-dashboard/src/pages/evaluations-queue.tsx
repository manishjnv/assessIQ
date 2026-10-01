// AssessIQ — Super-admin evaluation queue.
//
// /admin/platform/evaluations
//
// Every company's attempts that carry written answers and are waiting for
// AssessIQ to evaluate them (spec 2026-10-01 §11, wire contract §5b), oldest
// first. "Evaluate next" opens the oldest; finished (graded) attempts can be
// released to their company in bulk.
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
import { adminApi } from "../api.js";
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
}

interface EvaluationsResponse {
  items: EvaluationRow[];
  counts?: { pending: number; older_than_24h: number };
}

interface ReleaseResult {
  released: string[];
  skipped: Array<{ id: string; code: string }>;
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
      data-help-id="admin.evaluations.age_badge"
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

function StatusCell({ row }: { row: EvaluationRow }): React.ReactElement {
  const s = row.complete
    ? { label: "Ready to release", variant: "success" as const }
    : row.grading_in_progress
      ? { label: "Grading…", variant: "accent" as const }
      : { label: "Awaiting evaluation", variant: "accent" as const };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <Chip variant={s.variant}>{s.label}</Chip>
      {row.sent_back && (
        <span
          data-help-id="admin.evaluations.sent_back"
          title={row.sent_back_note ?? "Sent back by the company"}
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
  const { guard, stepUp } = useMfaGuard(
    "Releasing evaluations needs a fresh authenticator check. Enter your 6-digit code to continue.",
  );

  const fetchQueue = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      const data = await adminApi<EvaluationsResponse>("/admin/super/evaluations");
      setItems(data.items);
      setServerCounts(data.counts ?? null);
      setError(null);
    } catch (err) {
      setError(apiMessage(err, "Failed to load the evaluation queue."));
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
      label: "Company",
      width: "minmax(170px, 1.2fr)",
      render: (row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <input
            type="checkbox"
            aria-label={`Select ${row.assessment_name} for release`}
            disabled={!row.complete}
            title={row.complete ? undefined : "Finish the evaluation before releasing"}
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
    { key: "level_label", label: "Level", width: 80 },
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
          Evaluate
        </button>
      ),
    },
  ];

  const oldest = rows[0];

  return (
    <AdminShell
      breadcrumbs={[{ label: "Platform", href: "/admin/platform" }, "Evaluations"]}
      helpPage="admin.evaluations.queue"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-xl)" }}>
        {/* Page header — count chip + serif h1 + lede */}
        <div>
          <div style={{ marginBottom: 12 }}>
            <Chip leftIcon="grid">{pendingCount} in queue</Chip>
          </div>
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-3xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Evaluations.
          </h1>
          <p style={{ fontSize: 14, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Written answers from every company, oldest first. Evaluate each one, then release it to the company.
          </p>
        </div>

        {/* Counts */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--aiq-space-md)", maxWidth: 560 }}>
          <StatCard label="In queue" value={pendingCount} />
          <StatCard label="Older than 24 h" value={olderCount} />
        </div>

        {/* Toolbar */}
        <div className="aiq-admin-filter-strip" style={{ alignItems: "center", gap: "var(--aiq-space-md)", borderBottom: "1px solid var(--aiq-color-border)", paddingBottom: "var(--aiq-space-sm)" }}>
          <label data-help-id="admin.evaluations.tenant_filter" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={MONO_LABEL}>Company</span>
            <select
              className="aiq-input"
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">All companies</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="aiq-btn aiq-btn-outline"
            data-help-id="admin.evaluations.release_selected"
            disabled={chosen.length === 0 || releasing}
            onClick={() => void handleReleaseSelected()}
          >
            {releasing ? "Releasing…" : `Release selected to company${chosen.length > 0 ? ` (${chosen.length})` : ""}`}
          </button>
          <button
            type="button"
            className="aiq-btn aiq-btn-primary"
            data-help-id="admin.evaluations.evaluate_next"
            disabled={!oldest}
            onClick={() => oldest && navigate(`${DETAIL_PATH}/${oldest.attempt_id}`)}
          >
            Evaluate next
          </button>
        </div>

        {releaseResult && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap", fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" }}>
            <Chip variant="success">
              Released {releaseResult.released.length} to {releaseResult.released.length === 1 ? "its company" : "their companies"}
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

        <div className="aiq-card" data-density="compact" data-help-id="admin.evaluations.queue" style={{ padding: 0, overflow: "hidden" }}>
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
                emptyMessage="No evaluations in the queue."
              />
            )}
          </div>
        </div>
      </div>

      {stepUp}
    </AdminShell>
  );
}
