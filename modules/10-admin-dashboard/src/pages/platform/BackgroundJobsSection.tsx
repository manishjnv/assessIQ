// BackgroundJobsSection — "Background jobs" on the Platform page (FU-D9, 2026-10-06).
//
// Reuses the three super-admin worker routes (gate super_admin since FU-D8):
//   GET  /api/admin/worker/stats            → queue counts (5 s server cache)
//   GET  /api/admin/worker/failed           → up to 50 failed jobs
//   POST /api/admin/worker/failed/:id/retry → re-enqueue one failed job
//
// The queue is shared by every company (email, webhooks, cron). It never runs
// AI evaluation — that is a super-admin click on the Evaluations page.
//
// Kit: same section pattern as PlatformDomainsSection (serif h2 + HelpTip +
// count Chip, stat cards, zebra rows). The pending-task row says "tab"; the
// kit has no tab recipe, so this is a page section like the others on the
// Platform page (recorded in the Wave 2 report as a kit gap).
//
// Help ids are under the page prefix admin.platform (moved from admin.worker.*
// by migration 0158, FU-D10).

import React, { useCallback, useEffect, useState } from "react";
import { Button, Chip, Spinner, StatCard } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { adminApi, AdminApiError } from "../../api.js";
import { META_LABEL, ROW_PADDING } from "./shared.js";

interface WorkerStats {
  queue: string;
  fetched_at: string;
  cached: boolean;
  counts: { waiting: number; active: number; delayed: number; completed: number; failed: number };
}

interface FailedJob {
  id: string | null;
  name: string;
  attempts_made: number;
  failed_reason: string | null;
  stacktrace_tail: string | null;
  data: unknown;
  timestamp: number;
  finished_on: number | null;
}

const ROW_GRID = "110px 1.4fr 2fr 80px 150px 90px";

export function BackgroundJobsSection(): React.ReactElement {
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, f] = await Promise.all([
        adminApi<WorkerStats>("/admin/worker/stats"),
        adminApi<{ jobs: FailedJob[] }>("/admin/worker/failed"),
      ]);
      setStats(s);
      setFailed(f.jobs);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Failed to load background jobs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(id: string): Promise<void> {
    setRetrying(id);
    setError(null);
    try {
      await adminApi(`/admin/worker/failed/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" });
      setToast(`Job ${id.slice(0, 8)} re-queued.`);
      setTimeout(() => setToast(null), 4000);
      await load();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.apiError.message : "Retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }} data-help-id="admin.platform.jobs">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)" }}>
        <HelpTip helpId="admin.platform.jobs">
          <h2 className="aiq-serif" style={{ margin: 0, fontSize: 22, fontWeight: 400, letterSpacing: "-0.015em" }}>
            Background jobs
          </h2>
        </HelpTip>
        <span style={{ flex: 1 }} />
        {stats && (
          <span style={{ ...META_LABEL, fontSize: 10 }}>
            {stats.queue} · {stats.cached ? "cached" : "live"} · {new Date(stats.fetched_at).toLocaleTimeString()}
          </span>
        )}
        <Button size="sm" variant="outline" onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "var(--aiq-color-fg-secondary)", maxWidth: 640, lineHeight: 1.5 }}>
        One queue for every company: email, webhooks and the cron jobs. AI evaluation never runs here.
      </p>

      {error && <div><Chip>{error}</Chip></div>}
      {toast && <div><Chip variant="success">{toast}</Chip></div>}

      {stats && (
        <div style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
          <StatCard label="Waiting" value={stats.counts.waiting} />
          <StatCard label="Active" value={stats.counts.active} />
          <StatCard label="Delayed" value={stats.counts.delayed} />
          <StatCard label="Completed" value={stats.counts.completed} />
          <StatCard label="Failed" value={stats.counts.failed} />
        </div>
      )}

      {loading && stats === null ? (
        <div style={{ display: "grid", placeItems: "center", padding: "var(--aiq-space-xl) 0" }}>
          <Spinner aria-label="Loading background jobs" />
        </div>
      ) : failed.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--aiq-color-fg-muted)" }} data-help-id="admin.platform.jobs.failed">
          No failed jobs.
        </p>
      ) : (
        <div
          data-help-id="admin.platform.jobs.failed"
          style={{ border: "1px solid var(--aiq-color-border)", borderRadius: "var(--aiq-radius-md)", overflow: "hidden", background: "var(--aiq-color-bg-base)" }}
        >
          <div style={{ display: "grid", gridTemplateColumns: ROW_GRID, gap: 12, padding: "12px 20px", background: "var(--aiq-color-bg-raised)", borderBottom: "1px solid var(--aiq-color-border)", ...META_LABEL, fontSize: 10 }}>
            <span>Job</span>
            <span>Type</span>
            <span>Last error</span>
            <span>Tries</span>
            <span>Failed at</span>
            <span></span>
          </div>
          {failed.map((j, i) => {
            const id = j.id ?? `row-${i}`;
            const open = expanded === id;
            return (
              <React.Fragment key={id}>
                <div style={{ display: "grid", gridTemplateColumns: ROW_GRID, gap: 12, padding: ROW_PADDING, alignItems: "center", borderTop: i === 0 ? "none" : "1px solid var(--aiq-color-border)", background: i % 2 === 1 ? "var(--aiq-color-bg-raised)" : "transparent" }}>
                  <button
                    type="button"
                    className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                    style={{ justifyContent: "flex-start", padding: "2px 4px", fontFamily: "var(--aiq-font-mono)", fontSize: 12 }}
                    onClick={() => setExpanded(open ? null : id)}
                    aria-expanded={open}
                  >
                    {(j.id ?? "—").slice(0, 8)}
                  </button>
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12, color: "var(--aiq-color-fg-secondary)" }}>{j.name}</span>
                  <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={j.failed_reason ?? ""}>
                    {(j.failed_reason ?? "—").split("\n")[0]}
                  </span>
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 12 }}>{j.attempts_made}</span>
                  <span style={{ fontFamily: "var(--aiq-font-mono)", fontSize: 11, color: "var(--aiq-color-fg-muted)" }}>
                    {j.finished_on ? new Date(j.finished_on).toLocaleString() : "—"}
                  </span>
                  <div style={{ display: "flex", justifyContent: "flex-end" }} data-help-id="admin.platform.jobs.retry">
                    <Button size="sm" variant="ghost" disabled={j.id === null || retrying !== null} loading={retrying === j.id} onClick={() => j.id && void retry(j.id)}>
                      Retry
                    </Button>
                  </div>
                </div>
                {open && (
                  <div style={{ padding: "0 20px 16px", borderTop: "1px dashed var(--aiq-color-border)", background: "var(--aiq-color-bg-sunken)" }}>
                    <div style={{ ...META_LABEL, fontSize: 10, margin: "12px 0 4px" }}>Payload (sensitive fields redacted by the server)</div>
                    <pre style={{ margin: 0, fontFamily: "var(--aiq-font-mono)", fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
                      {JSON.stringify(j.data, null, 2)}
                    </pre>
                    {j.stacktrace_tail && (
                      <>
                        <div style={{ ...META_LABEL, fontSize: 10, margin: "12px 0 4px" }}>Error stack (tail)</div>
                        <pre style={{ margin: 0, fontFamily: "var(--aiq-font-mono)", fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
                          {j.stacktrace_tail}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
