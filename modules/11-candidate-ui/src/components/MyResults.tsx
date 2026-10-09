// AssessIQ — Candidate portal "My results" page (/candidate/results).
//
// The emailed sign-in link lands here (candidate magic-link verify redirects to
// /candidate/results). Lists the candidate's RELEASED results only, newest
// first — a result never appears before it is complete and published (owner
// rule P1). Each card is the shared ResultSummary: score ring, total / max,
// percent, Passed / Not passed and a certificate link when one was issued.
//
// Pattern: sibling of MyCertificates (same page chrome — count chip, serif h1
// ending in a period, lede). Empty state follows docs/design-system/patterns.md
// § Empty state (serif headline + short muted body, no illustration).

import React, { useEffect, useState } from 'react';
import { Card, Chip, Spinner, formatDate } from '@assessiq/ui-system';
import { listMyResults } from '../api.js';
import type { MyResultItemWire } from '../types.js';
import { ResultSummary } from './ResultSummary.js';

const HEADING: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-serif)',
  fontSize: 'var(--aiq-h1-size)',
  fontWeight: 400,
  margin: 0,
  letterSpacing: '-0.02em',
};

const META: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
  marginTop: 4,
};

export function MyResults(): React.ReactElement {
  const [items, setItems] = useState<MyResultItemWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMyResults()
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) {
          setError("We couldn't load your results. Refresh the page to try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // <div>, not <main>: CandidateShell already renders the page's <main>.
  return (
    <div
      data-help-id="candidate.results.list"
      style={{ padding: 'var(--aiq-space-xl)', maxWidth: 720 }}
    >
      {items !== null && (
        <div style={{ marginBottom: 12 }}>
          <Chip leftIcon="chart">
            {items.length} result{items.length !== 1 ? 's' : ''}
          </Chip>
        </div>
      )}
      <h1 style={HEADING}>My results.</h1>
      <p
        style={{
          fontSize: 14,
          color: 'var(--aiq-color-fg-secondary)',
          margin: '8px 0 var(--aiq-space-lg)',
          lineHeight: 1.5,
        }}
      >
        Results your organisation has released to you, newest first.
      </p>

      {error !== null ? (
        <p role="alert" style={{ color: 'var(--aiq-color-danger)', margin: 0 }}>
          {error}
        </p>
      ) : items === null ? (
        <Spinner aria-label="Loading your results" />
      ) : items.length === 0 ? (
        <div style={{ padding: '48px 0', maxWidth: 360 }}>
          <h2
            className="aiq-serif"
            style={{ fontSize: 22, fontWeight: 400, margin: '0 0 8px' }}
          >
            No results yet.
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              lineHeight: 1.5,
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            When an organisation releases a result for an assessment you took, it
            will appear here.
          </p>
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--aiq-space-lg)',
          }}
        >
          {items.map((r) => (
            <li key={r.attempt_id}>
              <Card as="article" padding="lg" aria-labelledby={`result-${r.attempt_id}`}>
                <div style={{ marginBottom: 'var(--aiq-space-lg)' }}>
                  <h2
                    id={`result-${r.attempt_id}`}
                    style={{
                      margin: 0,
                      fontSize: 'var(--aiq-text-base)',
                      fontWeight: 600,
                      color: 'var(--aiq-color-fg-primary)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {r.assessment_name}
                  </h2>
                  <div style={META}>
                    Released {formatDate(r.released_at)}
                  </div>
                </div>
                <ResultSummary
                  compact
                  totalEarned={r.total_earned}
                  totalMax={r.total_max}
                  percent={r.percent}
                  passed={r.passed}
                  certificate={r.certificate}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

MyResults.displayName = 'MyResults';
