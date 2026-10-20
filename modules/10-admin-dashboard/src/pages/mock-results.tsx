// AssessIQ — Admin Mock results page (Z-90).
//
// /admin/mock-results — read-only view of how students do in MOCK tests and where
// they are weak. Source: GET /api/admin/mock/{summary,topics,students,trend,not-taken}
// (module 15-analytics). Mock numbers never appear in the real-exam reports.
//
// INVARIANTS:
//  - No export, no edit controls. Nothing here changes marks.
//  - No claude/anthropic imports or copy.

import React, { useEffect, useState } from "react";
import { EmptyState, Spinner } from "@assessiq/ui-system";
import { HelpTip } from "@assessiq/help-system/components";
import { AdminShell } from "../components/AdminShell.js";
import { adminApi, AdminApiError } from "../api.js";

interface Summary {
  mock_attempts: number;
  students: number;
  completed_pct: number;
  avg_score_pct: number | null;
  by_assessment: Array<{ assessment_id: string; name: string; attempts: number; avg_score_pct: number | null; last_taken_at: string | null }>;
}
interface Topic { topic: string; attempts_graded: number; correct_pct: number }
interface Topics { topics: Topic[]; strongest: Topic[]; weakest: Topic[] }
interface Student { user_id: string; name: string; mock_attempts: number; avg_score_pct: number | null; last_score_pct: number | null; last_taken_at: string | null }
interface TrendPoint { date: string; score_pct: number; attempts: number }
interface NotTaken { user_id: string; name: string; email: string }

const BOX: React.CSSProperties = {
  border: "1px solid var(--aiq-color-border)",
  borderRadius: "var(--aiq-radius-md)",
  padding: "var(--aiq-space-md) var(--aiq-space-lg)",
};
const H2: React.CSSProperties = {
  fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-xl)", fontWeight: 400, margin: 0, letterSpacing: "-0.015em",
};
const SMALL: React.CSSProperties = { fontFamily: "var(--aiq-font-sans)", fontSize: "var(--aiq-text-sm)" };
const pct = (v: number | null): string => (v === null ? "-" : `${v}%`);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "-");

function Section({ title, helpId, children }: { title: string; helpId: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section style={{ ...BOX, display: "flex", flexDirection: "column", gap: "var(--aiq-space-sm)" }}>
      <HelpTip helpId={helpId}><h2 style={H2}>{title}</h2></HelpTip>
      {children}
    </section>
  );
}

function Tile({ label, value, testId }: { label: string; value: string; testId: string }): React.ReactElement {
  return (
    <div style={{ ...BOX, flex: "1 1 160px" }} data-testid={testId}>
      <div style={{ ...SMALL, color: "var(--aiq-color-fg-secondary)" }}>{label}</div>
      <div style={{ fontFamily: "var(--aiq-font-serif)", fontSize: "var(--aiq-text-2xl)" }}>{value}</div>
    </div>
  );
}

function TopicBars({ rows, testId }: { rows: Topic[]; testId: string }): React.ReactElement {
  if (rows.length === 0) return <p style={SMALL}>No graded answers yet.</p>;
  return (
    <ul data-testid={testId} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--aiq-space-xs)" }}>
      {rows.map((t) => (
        <li key={t.topic} style={SMALL}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{t.topic}</span><span>{t.correct_pct}% correct ({t.attempts_graded} answers)</span>
          </div>
          <div style={{ height: 6, background: "var(--aiq-color-bg-raised)", borderRadius: 3 }}>
            <div style={{ height: 6, width: `${Math.min(100, t.correct_pct)}%`, background: "var(--aiq-color-accent)", borderRadius: 3 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// Plain SVG line: x = day order, y = average score 0..100.
function TrendChart({ points }: { points: TrendPoint[] }): React.ReactElement {
  const W = 600, H = 160, P = 24;
  const x = (i: number): number => (points.length < 2 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const y = (v: number): number => H - P - (Math.max(0, Math.min(100, v)) * (H - 2 * P)) / 100;
  const line = points.map((p, i) => `${x(i)},${y(p.score_pct)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average mock score by day" style={{ width: "100%", maxWidth: W }} data-testid="mock-trend-chart">
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--aiq-color-border)" />
      <line x1={P} y1={P} x2={P} y2={H - P} stroke="var(--aiq-color-border)" />
      <text x={2} y={P + 4} fontSize="10" fill="var(--aiq-color-fg-muted)">100%</text>
      <text x={2} y={H - P} fontSize="10" fill="var(--aiq-color-fg-muted)">0%</text>
      <polyline points={line} fill="none" stroke="var(--aiq-color-accent)" strokeWidth="2" />
      {points.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.score_pct)} r="3" fill="var(--aiq-color-accent)">
          <title>{`${p.date}: ${p.score_pct}% (${p.attempts} mocks)`}</title>
        </circle>
      ))}
      {points.length > 0 && (
        <>
          <text x={P} y={H - 6} fontSize="10" fill="var(--aiq-color-fg-muted)">{points[0]!.date}</text>
          <text x={W - P} y={H - 6} fontSize="10" textAnchor="end" fill="var(--aiq-color-fg-muted)">{points[points.length - 1]!.date}</text>
        </>
      )}
    </svg>
  );
}

export function AdminMockResults(): React.ReactElement {
  const [assessmentId, setAssessmentId] = useState("");
  const [options, setOptions] = useState<Summary["by_assessment"]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [topics, setTopics] = useState<Topics | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [notTaken, setNotTaken] = useState<NotTaken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = assessmentId ? `?assessmentId=${encodeURIComponent(assessmentId)}` : "";
    (async () => {
      try {
        const [s, t, st, tr, nt] = await Promise.all([
          adminApi<{ data: Summary }>(`/admin/mock/summary${qs}`),
          adminApi<{ data: Topics }>(`/admin/mock/topics${qs}`),
          adminApi<{ data: Student[] }>(`/admin/mock/students${qs}`),
          adminApi<{ data: TrendPoint[] }>(`/admin/mock/trend${qs}`),
          assessmentId
            ? adminApi<{ data: NotTaken[] }>(`/admin/mock/not-taken${qs}`)
            : Promise.resolve({ data: [] as NotTaken[] }),
        ]);
        if (cancelled) return;
        setSummary(s.data);
        if (!assessmentId) setOptions(s.data.by_assessment);
        setTopics(t.data);
        setStudents(st.data);
        setTrend(tr.data);
        setNotTaken(nt.data);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof AdminApiError ? err.apiError.message : "Could not load mock results.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [assessmentId]);

  const sorted = [...students].sort((a, b) => {
    const d = (a.avg_score_pct ?? -1) - (b.avg_score_pct ?? -1);
    return asc ? d : -d;
  });
  const empty = !loading && !error && summary !== null && summary.mock_attempts === 0 && !assessmentId;

  return (
    <AdminShell breadcrumbs={["Reports", "Mock results"]} helpPage="admin.mock_results">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--aiq-space-lg)" }}>
        <header style={{ display: "flex", alignItems: "center", gap: "var(--aiq-space-sm)", flexWrap: "wrap" }}>
          <HelpTip helpId="admin.mock_results.page"><h1 style={{ ...H2, fontSize: "var(--aiq-text-2xl)" }}>Mock results</h1></HelpTip>
          <span style={{ ...SMALL, border: "1px solid var(--aiq-color-border)", borderRadius: 999, padding: "2px 10px" }}>Mock</span>
          <label style={{ ...SMALL, marginLeft: "auto" }}>
            Assessment{" "}
            <select className="aiq-input" value={assessmentId} onChange={(e) => setAssessmentId(e.target.value)} aria-label="Assessment filter">
              <option value="">All mock assessments</option>
              {options.map((o) => <option key={o.assessment_id} value={o.assessment_id}>{o.name}</option>)}
            </select>
          </label>
        </header>

        {error && <div role="alert" style={{ ...SMALL, color: "var(--aiq-color-danger)" }}>{error}</div>}
        {loading && <Spinner size="sm" aria-label="Loading" />}

        {empty && (
          <EmptyState
            title="No mock tests have been taken yet."
            body="Invite candidates to a Mock test to see results here."
          />
        )}

        {!loading && !error && summary && !empty && (
          <>
            <div style={{ display: "flex", gap: "var(--aiq-space-md)", flexWrap: "wrap" }}>
              <Tile testId="tile-attempts" label="Mock attempts" value={String(summary.mock_attempts)} />
              <Tile testId="tile-students" label="Students" value={String(summary.students)} />
              <Tile testId="tile-average" label="Average score" value={pct(summary.avg_score_pct)} />
              <Tile testId="tile-completed" label="Completed" value={`${summary.completed_pct}%`} />
            </div>

            <Section title="Weak and strong topics" helpId="admin.mock_results.topics">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--aiq-space-lg)" }}>
                <div><h3 style={SMALL}>Weakest topics</h3><TopicBars testId="weak-topics" rows={topics?.weakest ?? []} /></div>
                <div><h3 style={SMALL}>Strongest topics</h3><TopicBars testId="strong-topics" rows={topics?.strongest ?? []} /></div>
              </div>
            </Section>

            <Section title="Students" helpId="admin.mock_results.students">
              {sorted.length === 0 ? <p style={SMALL}>No students yet.</p> : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ ...SMALL, width: "100%", borderCollapse: "collapse" }} data-testid="students-table">
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        <th>Student</th><th>Mocks</th>
                        <th aria-sort={asc ? "ascending" : "descending"}>
                          <button type="button" onClick={() => setAsc(!asc)} style={{ all: "unset", cursor: "pointer", fontWeight: 600 }}>
                            Average {asc ? "(low first)" : "(high first)"}
                          </button>
                        </th>
                        <th>Last score</th><th>Last taken</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((s) => (
                        <tr key={s.user_id}>
                          <td>{s.name}</td><td>{s.mock_attempts}</td><td>{pct(s.avg_score_pct)}</td>
                          <td>{pct(s.last_score_pct)}</td><td>{day(s.last_taken_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="Trend" helpId="admin.mock_results.trend">
              {trend.length === 0 ? <p style={SMALL}>No scored mocks yet.</p> : <TrendChart points={trend} />}
            </Section>

            <Section title="Not taken" helpId="admin.mock_results.not_taken">
              {!assessmentId ? (
                <p style={SMALL}>Pick one assessment above to see who has not taken it.</p>
              ) : notTaken.length === 0 ? (
                <p style={SMALL}>Everyone invited has taken this mock.</p>
              ) : (
                <ul data-testid="not-taken-list" style={{ ...SMALL, margin: 0, paddingLeft: "var(--aiq-space-lg)" }}>
                  {notTaken.map((n) => <li key={n.user_id}>{n.name} ({n.email})</li>)}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </AdminShell>
  );
}
