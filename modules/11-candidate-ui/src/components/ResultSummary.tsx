// AssessIQ — ResultSummary: the candidate-facing COMPLETE result.
//
// Shared by the post-submit page (apps/web/src/pages/take/Submitted.tsx) and
// the portal list (MyResults.tsx). Owner rule P1 (2026-10-01): a candidate sees
// only the final total, percent, pass/fail and certificate link — never
// per-question data, bands, AI insights, a competency breakdown or a percentile.
//
// Kit reference: AssessIQ_UI_Template/screens/results.jsx (ScoreRing + score
// block only) and mobile-screens/results.jsx, per docs/10-branding-guideline.md
// § 0. Diverges from screens/results.jsx because: the production ScoreRing
// primitive is 0-100 (percent) at fixed sizes, so the raw score sits beside it
// instead of inside, and the breakdown / insights / percentile blocks of that
// screen are excluded by P1. Mobile: no viewport branch — the row is
// flex-wrap, so the ring stacks above the numbers on narrow screens.

import React from 'react';
import { Chip, Icon, Num, ScoreRing } from '@assessiq/ui-system';
import type { ResultCertificateWire } from '../types.js';

export interface ResultSummaryProps {
  totalEarned: number;
  totalMax: number;
  /** 0-100, as sent by the API (one decimal place). */
  percent: number;
  passed: boolean;
  certificate?: ResultCertificateWire | null;
  /** List-row size: smaller ring and score number. */
  compact?: boolean;
}

const EYEBROW: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
  marginBottom: 6,
};

const MUTED_14: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--aiq-color-fg-secondary)',
};

/** 42 → "42", 37.5 → "37.5", 66.666 → "66.67" (max `dp` decimals, no trailing zeros). */
function trim(n: number, dp: number): string {
  return String(Number(n.toFixed(dp)));
}

export function ResultSummary({
  totalEarned,
  totalMax,
  percent,
  passed,
  certificate = null,
  compact = false,
}: ResultSummaryProps): React.ReactElement {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '16px 28px',
        }}
      >
        {/* Decorative: the exact numbers are in the text beside the ring. */}
        <div aria-hidden="true" style={{ flexShrink: 0 }}>
          <ScoreRing value={Math.round(percent)} size={compact ? 'md' : 'lg'} />
        </div>

        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <div style={EYEBROW}>Your score</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '2px 10px',
            }}
          >
            <Num
              value={totalEarned}
              format={(n) => trim(n, 2)}
              style={{
                fontSize: compact ? 28 : 48,
                lineHeight: 1,
                letterSpacing: '-0.03em',
              }}
            />{' '}
            <span style={MUTED_14}>/ {trim(totalMax, 2)}</span>{' '}
            <span style={MUTED_14}>({trim(percent, 1)}%)</span>
          </div>
          <div style={{ marginTop: 12 }}>
            {passed ? (
              <Chip variant="success">Passed</Chip>
            ) : (
              <Chip variant="warn" leftIcon="close">
                Not passed
              </Chip>
            )}
          </div>
        </div>
      </div>

      {certificate !== null && (
        <div
          style={{
            marginTop: compact ? 12 : 20,
            paddingTop: compact ? 12 : 20,
            borderTop: '1px solid var(--aiq-color-border)',
          }}
        >
          <a
            className="aiq-btn aiq-btn-outline"
            href={certificate.verify_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View certificate
            <Icon name="arrow" size={14} aria-hidden />
          </a>
        </div>
      )}
    </div>
  );
}

ResultSummary.displayName = 'ResultSummary';
