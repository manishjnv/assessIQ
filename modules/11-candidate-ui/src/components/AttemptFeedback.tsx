// AssessIQ - "Review your answers" for one released result (RW-80).
//
// Collapsed by default; fetches GET /api/me/attempts/:id/feedback only on expand
// (never on list load). The parent renders it only when the tenant level is not
// "none". The explanation block follows docs/10-branding-guideline.md section 8.5
// "AI justification block": serif italic 15px on --aiq-color-bg-raised.

import React, { useState } from 'react';
import { Button, Chip, MathText, Spinner } from '@assessiq/ui-system';
import { getAttemptFeedback } from '../api.js';
import type { AttemptFeedbackWire, FeedbackItemWire } from '../types.js';

const OUTCOME: Record<FeedbackItemWire['outcome'], { label: string; tone: 'success' | 'warn' | 'default' }> = {
  correct: { label: 'Correct', tone: 'success' },
  partial: { label: 'Partly correct', tone: 'warn' },
  incorrect: { label: 'Not correct', tone: 'default' },
};

const LABEL: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const ROW: React.CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--aiq-color-fg-primary)', overflowWrap: 'anywhere' };

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export interface AttemptFeedbackProps {
  attemptId: string;
}

export function AttemptFeedback({ attemptId }: AttemptFeedbackProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AttemptFeedbackWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `feedback-${attemptId}`;

  const load = (): void => {
    setLoading(true);
    setError(null);
    getAttemptFeedback(attemptId)
      .then((res) => setData(res))
      .catch(() => setError('We could not load your answers. Try again.'))
      .finally(() => setLoading(false));
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && data === null && !loading) load();
  };

  const items = data?.items ?? [];
  const showExpected = items.some((i) => i.expected_answer !== null);

  return (
    <section data-help-id="candidate.results.feedback" style={{ marginTop: 'var(--aiq-space-lg)' }}>
      <Button variant="outline" size="sm" onClick={toggle} aria-expanded={open} aria-controls={panelId}>
        {open ? 'Hide your answers' : 'Review your answers'}
      </Button>
      {open && (
        <div id={panelId} style={{ marginTop: 'var(--aiq-space-md)' }}>
          {loading ? (
            <Spinner aria-label="Loading your answers" />
          ) : error !== null ? (
            <div role="alert">
              <p style={{ margin: '0 0 8px', color: 'var(--aiq-color-danger)', fontSize: 13 }}>{error}</p>
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </div>
          ) : data !== null && items.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--aiq-color-fg-secondary)' }}>No questions to show.</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--aiq-space-md)' }}>
              {items.map((it) => {
                const o = OUTCOME[it.outcome];
                const study =
                  it.study.unit !== null
                    ? `${it.study.unit}${it.study.subject !== null ? ` (${it.study.subject})` : ''}`
                    : it.study.topic;
                return (
                  <li
                    key={it.question_id}
                    style={{ borderTop: '1px solid var(--aiq-color-border)', paddingTop: 'var(--aiq-space-md)' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={LABEL}>Q{it.position}</span>
                      <Chip variant={o.tone}>{o.label}</Chip>
                    </div>
                    {it.math === true ? (
                      // EXP-10: a maths prompt is drawn whole (a cut could split an expression) and clamped by CSS to 3 lines.
                      <p style={{ ...ROW, margin: '6px 0 0', fontWeight: 500, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        <MathText text={it.prompt} math />
                      </p>
                    ) : (
                      <p title={it.prompt} style={{ ...ROW, margin: '6px 0 0', fontWeight: 500 }}>
                        {truncate(it.prompt, 120)}
                      </p>
                    )}
                    <p style={{ ...ROW, margin: '6px 0 0' }}>
                      <span style={LABEL}>Your answer </span>
                      {it.your_answer ?? 'No answer'}
                    </p>
                    {showExpected && it.expected_answer !== null && (
                      <p data-help-id="candidate.results.feedback.expected" style={{ ...ROW, margin: '4px 0 0' }}>
                        <span style={LABEL}>Expected answer </span>
                        {it.expected_answer}
                      </p>
                    )}
                    {it.explanation !== null && (
                      <p
                        data-help-id="candidate.results.feedback.explanation"
                        style={{
                          margin: '8px 0 0',
                          padding: '10px 12px',
                          background: 'var(--aiq-color-bg-raised)',
                          borderRadius: 'var(--aiq-radius-md)',
                          fontFamily: 'var(--aiq-font-serif)',
                          fontStyle: 'italic',
                          fontSize: 15,
                          lineHeight: 1.5,
                          color: 'var(--aiq-color-fg-secondary)',
                        }}
                      >
                        {it.explanation}
                      </p>
                    )}
                    <p
                      data-help-id="candidate.results.feedback.study"
                      style={{ ...ROW, margin: '6px 0 0', color: 'var(--aiq-color-fg-secondary)' }}
                    >
                      What to study: {study}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

AttemptFeedback.displayName = 'AttemptFeedback';
