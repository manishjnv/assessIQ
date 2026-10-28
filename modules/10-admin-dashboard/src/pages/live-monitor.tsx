// AssessIQ - Live monitor (X6a). /admin/assessments/:id/live
//
// Read-only view of one assessment while candidates sit it: how many are invited, not started,
// in progress and submitted, plus when each in-progress candidate was last seen.
// Polls every 15 seconds. Polling pauses while the tab is hidden and refreshes when it is visible again.
//
// Fetches: GET /api/admin/assessments/:id/live-monitor (see api/live-monitor.ts).
// INVARIANTS: no claude/anthropic imports or copy. No answers, scores or camera data are shown.

import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Table, formatDateTime, formatRelative } from "@assessiq/ui-system";
import type { ColumnDef } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { AdminApiError } from "../api.js";
import { getLiveMonitorApi } from "../api/live-monitor.js";
import type { LiveMonitorResponse, LiveMonitorRow } from "../api/live-monitor.js";

export const LIVE_MONITOR_POLL_MS = 15_000;

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-mono)",
  fontSize: "var(--aiq-text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--aiq-color-fg-muted)",
};

const BODY_STYLE: React.CSSProperties = {
  fontFamily: "var(--aiq-font-sans)",
  fontSize: "var(--aiq-text-sm)",
  color: "var(--aiq-color-fg-primary)",
};

function errorText(err: unknown): string {
  return err instanceof AdminApiError ? err.apiError.message : "Could not load the live monitor. Try again.";
}

/** Calls `load` now, then every `ms`. Skips the tick while the tab is hidden; loads again when it turns visible. */
function useVisiblePolling(load: () => Promise<void>, ms: number): void {
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, ms]);
}

export function LiveMonitor(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<LiveMonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setData(await getLiveMonitorApi(id));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useVisiblePolling(load, LIVE_MONITOR_POLL_MS);

  const now = data ? new Date(data.server_time) : new Date();
  const tiles: Array<[string, number | undefined]> = [
    ["Invited", data?.counts.invited],
    ["Not started", data?.counts.not_started],
    ["In progress", data?.counts.in_progress],
    ["Submitted", data?.counts.submitted],
  ];

  const columns: ColumnDef<LiveMonitorRow>[] = [
    {
      key: "name", label: "Candidate",
      render: (r) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={BODY_STYLE}>{r.name ?? r.email ?? r.user_id}</span>
          {r.email != null && r.name != null ? (
            <span style={{ ...LABEL_STYLE, textTransform: "none" }}>{r.email}</span>
          ) : null}
        </div>
      ),
    },
    { key: "started_at", label: "Started", render: (r) => formatDateTime(r.started_at) },
    {
      key: "last_seen_at", label: "Last seen",
      render: (r) => (
        <HelpTip helpId="admin.live_monitor.last_seen">
          <span style={{ ...BODY_STYLE, fontWeight: 600 }} title={formatDateTime(r.last_seen_at)}>
            {formatRelative(r.last_seen_at, now)}
          </span>
        </HelpTip>
      ),
    },
  ];

  return (
    <AdminShell
      breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, { label: "Detail", href: `/admin/assessments/${id ?? ""}` }, "Live monitor"]}
      helpPage="admin.live_monitor"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <div data-help-id="admin.live_monitor.page">
          <h1 style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontWeight: 400, margin: 0, letterSpacing: "-0.02em" }}>
            Live monitor.
          </h1>
          <p style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-secondary)", margin: "8px 0 0", maxWidth: 640 }}>
            Who has started this test and who is still writing. The page refreshes every 15 seconds while this tab is open.{" "}
            <Link to={`/admin/assessments/${id ?? ""}`}>Back to the assessment</Link>
          </p>
        </div>

        {error ? <div role="alert" style={{ ...BODY_STYLE, color: "var(--aiq-color-danger)" }}>{error}</div> : null}

        <HelpTip helpId="admin.live_monitor.counts">
          <div role="group" aria-label="Candidate counts" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--aiq-space-md)" }}>
            {tiles.map(([label, value]) => (
              <div key={label} className="aiq-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={LABEL_STYLE}>{label}</span>
                <span style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-h1-size)", fontVariantNumeric: "tabular-nums" }}>
                  {value ?? "–"}
                </span>
              </div>
            ))}
          </div>
        </HelpTip>

        <div style={LABEL_STYLE} role="status" aria-live="polite">
          {data ? `Updated ${formatDateTime(data.server_time)}` : error ? "" : "Loading"}
        </div>

        {data && data.in_progress.length === 0 ? (
          <div style={{ ...BODY_STYLE, color: "var(--aiq-color-fg-muted)" }}>No one is writing this test now.</div>
        ) : null}

        {data && data.in_progress.length > 0 ? (
          <div data-help-id="admin.live_monitor.list" className="aiq-card" data-density="compact" style={{ padding: 0, overflow: "hidden" }}>
            <Table columns={columns} data={data.in_progress} emptyMessage="No one is writing this test now." />
          </div>
        ) : null}
      </div>
    </AdminShell>
  );
}
