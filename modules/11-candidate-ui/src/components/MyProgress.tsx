// AssessIQ — Candidate portal "Progress" page (/candidate/progress, RW-84).
//
// Shows released attempts only: a score trend, a history table and per-subject
// strengths. Nothing unreleased reaches this page (the API filters on
// attempts.status = 'released').
//
// Kit recipes followed (modules/17-ui-system/AssessIQ_UI_Template/design-system/patterns.md):
//   § Results / report layout (screens/results.jsx): score block row, then the
//   "Competency breakdown" card (name · neutral bar · score) for subjects.
//   § Page header recipe + § Section header pattern + § Empty state.
// docs/10-branding-guideline.md § 8.6 (sparkline, shown for 2+ points) and § 4
// (candidate screens use comfortable density).

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  PageHeader,
  ProgressBar,
  Sparkline,
  Spinner,
  StatCard,
  StatusPill,
  Table,
  formatDate,
} from '@assessiq/ui-system';
import type { ColumnDef } from '@assessiq/ui-system';
import { getMyProgress } from '../api.js';
import type { CandidateProgress, ProgressAttempt, ProgressSubject } from '../api.js';

const SECTION_H: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  fontSize: 22,
  fontWeight: 400,
  margin: '0 0 var(--aiq-space-md)',
};

const MUTED: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--aiq-color-fg-secondary)',
  margin: 0,
  lineHeight: 1.5,
};

function band(rate: number): { label: string; variant: 'success' | 'accent' | 'warn' } {
  if (rate >= 75) return { label: 'Strong', variant: 'success' };
  if (rate >= 50) return { label: 'Developing', variant: 'accent' };
  return { label: 'Focus', variant: 'warn' };
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

const COLUMNS: ColumnDef<ProgressAttempt>[] = [
  { key: 'assessment_name', label: 'Assessment', width: 'minmax(140px, 2fr)' },
  { key: 'released_at', label: 'Date', width: 120, render: (r) => formatDate(r.released_at) },
  {
    key: 'score',
    label: 'Score',
    width: 'minmax(120px, 1fr)',
    render: (r) =>
      `${fmt(r.total_earned)} / ${fmt(r.total_max)}${r.score_pct === null ? '' : ` (${fmt(r.score_pct)}%)`}`,
  },
  {
    key: 'passed',
    label: 'Result',
    width: 120,
    render: (r) =>
      r.passed === null ? (
        <StatusPill status="not_set" label="Not set" />
      ) : (
        <StatusPill
          status={r.passed ? 'passed' : 'failed'}
          tone={r.passed ? 'success' : 'warn'}
          label={r.passed ? 'Passed' : 'Not passed'}
        />
      ),
  },
  {
    key: 'certificate',
    label: 'Certificate',
    width: 100,
    render: (r) =>
      r.certificate === null ? (
        '—'
      ) : (
        <a
          href={r.certificate.verify_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--aiq-color-accent)' }}
        >
          View
        </a>
      ),
  },
];

function SubjectRow({ s }: { s: ProgressSubject }): React.ReactElement {
  const b = band(s.rate_pct);
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(100px, 200px) 1fr auto auto',
        gap: 'var(--aiq-space-md)',
        alignItems: 'center',
      }}
    >
      <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{s.label}</span>
      <ProgressBar value={s.rate_pct} max={100} label={`${s.label}: ${fmt(s.rate_pct)} percent correct`} />
      <span style={{ fontFamily: 'var(--aiq-font-mono)', fontSize: 12, color: 'var(--aiq-color-fg-muted)' }}>
        {s.correct} / {s.questions}
      </span>
      <Chip variant={b.variant}>{b.label}</Chip>
    </li>
  );
}

function Body({ data }: { data: CandidateProgress }): React.ReactElement {
  const scored = data.attempts.map((a) => a.score_pct).filter((p): p is number => p !== null);
  const avg = scored.length === 0 ? 0 : scored.reduce((x, y) => x + y, 0) / scored.length;
  const best = scored.length === 0 ? 0 : Math.max(...scored);
  return (
    <div style={{ display: 'grid', gap: 'var(--aiq-space-xl)' }}>
      <section data-help-id="candidate.progress.trend" aria-label="Score trend">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--aiq-space-md)',
          }}
        >
          <StatCard label="Tests taken" value={data.attempts.length} />
          <StatCard label="Average score" value={Math.round(avg * 10) / 10} unit="%" />
          <StatCard label="Best score" value={Math.round(best * 10) / 10} unit="%" />
        </div>
        <div style={{ marginTop: 'var(--aiq-space-md)' }}>
          {data.trend.length >= 2 ? (
            <Card padding="lg">
              <div style={{ fontSize: 12, color: 'var(--aiq-color-fg-muted)', marginBottom: 8 }}>
                Score trend, oldest to newest
              </div>
              <Sparkline
                data={data.trend}
                width={320}
                height={56}
                aria-label={`Score trend over ${data.trend.length} tests`}
                data-test-id="progress-sparkline"
              />
            </Card>
          ) : (
            <p style={MUTED}>Take one more test to see your score trend.</p>
          )}
        </div>
      </section>

      <section data-help-id="candidate.progress.history" aria-labelledby="progress-history">
        <h2 id="progress-history" style={SECTION_H}>
          Your tests
        </h2>
        <Table<ProgressAttempt> data={data.attempts} columns={COLUMNS} rowKey={(r) => r.attempt_id} />
      </section>

      <section data-help-id="candidate.progress.subjects" aria-labelledby="progress-subjects">
        <h2 id="progress-subjects" style={SECTION_H}>
          Strengths by subject
        </h2>
        {data.subjects.length === 0 ? (
          <p style={MUTED}>Subject results appear after your answers are graded.</p>
        ) : (
          <Card padding="lg">
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--aiq-space-md)',
              }}
            >
              {data.subjects.map((s) => (
                <SubjectRow key={s.node_id} s={s} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

export function MyProgress(): React.ReactElement {
  const [data, setData] = useState<CandidateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getMyProgress()
      .then(setData)
      .catch(() => setError('We could not load your progress.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // <div>, not <main>: CandidateShell already renders the page's <main>.
  return (
    <div style={{ padding: 'var(--aiq-space-xl)', maxWidth: 1080 }} data-help-id="candidate.progress">
      <PageHeader
        title="Progress"
        {...(data !== null ? { count: data.attempts.length } : {})}
        lede="How your released results change over time."
      />

      {error !== null ? (
        <div role="alert" style={{ color: 'var(--aiq-color-danger)' }}>
          <p style={{ margin: '0 0 8px' }}>{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      ) : data === null ? (
        <Spinner aria-label="Loading your progress" />
      ) : data.attempts.length === 0 ? (
        <EmptyState
          title="No released results yet"
          body="Your progress appears here after an organisation releases a result."
        />
      ) : (
        <Body data={data} />
      )}
    </div>
  );
}

MyProgress.displayName = 'MyProgress';
