// AssessIQ — QuestionStatsCard (RW-60 / FU-C14, Phase C item report)
//
// Super admin only. Kit recipes: design-system/components.md "Chips" (state chips:
// Noise / Miscalibrated / Calibrated) and "Stat card"; screens/activity.jsx (stat cards in a
// responsive row). Data: GET /api/admin/super/questions/:id/stats (nightly question_stats_mv).
// No chart when there is no volume: a plain note instead.

import React, { useEffect, useState } from "react";
import { Chip, StatCard, Table, formatDate } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { getSuperQuestionStats, type QuestionStatsResponse } from "../api.js";

const pct = (v: number | null): number => (v === null ? 0 : Math.round(v * 1000) / 10);
const LABEL: React.CSSProperties = { fontFamily: "var(--aiq-font-mono)", fontSize: "var(--aiq-text-xs)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--aiq-color-fg-muted)" };
const MUTED: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)", color: "var(--aiq-color-fg-muted)" };

export function QuestionStatsCard({ questionId }: { questionId: string }): React.ReactElement {
  const [data, setData] = useState<QuestionStatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getSuperQuestionStats(questionId).then(setData).catch(() => setErr("Could not load item statistics."));
  }, [questionId]);

  const s = data?.stats ?? null;
  const hasVolume = s !== null && s.attempts > 0;
  const success = s ? (s.mean_band ?? s.correct_rate) : null;

  return (
    <div className="aiq-card" data-test-id="question-stats-card" style={{ padding: "var(--aiq-space-lg)", display: "flex", flexDirection: "column", gap: "var(--aiq-space-md)" }}>
      <HelpTip helpId="admin.question.editor.stats"><div style={LABEL}>Item statistics (Phase C)</div></HelpTip>
      {err && <div role="alert" style={MUTED}>{err}</div>}
      {data?.scope === "rollup" && <div data-test-id="stats-scope" style={MUTED}>Across {data.clone_count} {data.clone_count === 1 ? "copy" : "copies"} of this platform question in customer organisations.</div>}
      {!err && data && !hasVolume && (
        <div role="status" style={MUTED}>No graded attempts on this question yet. Statistics appear after the nightly refresh.</div>
      )}
      {data && s && hasVolume && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--aiq-space-md)" }}>
            <StatCard label="Attempts" value={s.attempts} />
            <StatCard label={s.mean_band !== null ? "Mean band" : "Correct rate"} value={pct(success)} unit="%" />
            <StatCard label="Discrimination" value={s.point_biserial ?? 0} />
            <StatCard label="Exposure" value={s.exposure_count} />
          </div>
          <div style={{ ...MUTED, display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
            <HelpTip helpId="admin.question.editor.stats.discrimination"><span>Discrimination: {s.point_biserial === null ? "not enough data" : s.point_biserial.toFixed(2)}</span></HelpTip>
            {s.discrimination_ok === false && <Chip variant="warn">Noise</Chip>}
            <span>Last used: {formatDate(s.last_used_at)}</span>
          </div>
          <HelpTip helpId="admin.question.editor.stats.gradient">
            <div style={LABEL}>Level gradient (L1 should score above L2, L2 above L3)</div>
          </HelpTip>
          <Table
            data={data.gradient}
            rowKey={(r) => String(r.level_position)}
            rowStyle={(r) => (r.level_position === data.question.level_position ? { background: "var(--aiq-color-bg-sunken)" } : {})}
            columns={[
              { key: "label", label: "Level", render: (r) => <>{r.label}{r.level_position === data.question.level_position ? " (this question)" : ""}</> },
              { key: "mean_success", label: "Mean success", render: (r) => (r.mean_success === null ? "—" : `${pct(r.mean_success)}%`) },
              { key: "attempts", label: "Attempts" },
            ]}
          />
          <div style={{ display: "flex", gap: "var(--aiq-space-sm)", alignItems: "center", flexWrap: "wrap" }}>
            <HelpTip helpId="admin.question.editor.stats.miscalibrated">
              {data.miscalibrated.flag ? <Chip variant="warn">Miscalibrated</Chip> : <Chip variant="success">Calibrated</Chip>}
            </HelpTip>
            {data.miscalibrated.reason && <span style={MUTED}>{data.miscalibrated.reason}</span>}
          </div>
          {s.attempts < data.miscalibrated.min_attempts && (
            <div style={MUTED}>Phase C needs {data.miscalibrated.min_attempts}+ attempts.</div>
          )}
        </>
      )}
    </div>
  );
}
