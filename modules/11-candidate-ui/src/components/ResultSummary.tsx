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
import { feedbackSentence } from '@assessiq/core/feedback-copy';
import { Chip, Icon, Num, ScoreRing } from '@assessiq/ui-system';
import { certificateRuleText, resultSupportLine, retakeLine } from '../copy.js';
import type { ResultCertificateWire, ResultNegativeMarkingWire, ResultRetakeWire, ResultSectionWire } from '../types.js';

export interface ResultSummaryProps {
  totalEarned: number;
  totalMax: number;
  /** 0-100, as sent by the API (one decimal place). */
  percent: number;
  passed: boolean;
  /** Z-16: pass mark in percent from the payload. Undefined hides the number (never guess one). */
  passMark?: number | undefined;
  certificate?: ResultCertificateWire | null;
  /** EX-1: when enabled, a one-line note shows the marks deducted. totalEarned may be negative. */
  negativeMarking?: ResultNegativeMarkingWire | undefined;
  /** List-row size: smaller ring and score number. */
  compact?: boolean;
  /** Z-9: names the assessment in the pass headline. */
  assessmentName?: string | undefined;
  /** Z-9: names the organisation in the fail next step. Falls back to "your organisation". */
  tenantName?: string | undefined;
  /** Z-9: true when per-question feedback is on (feedbackLevel !== 'none'). */
  feedbackOn?: boolean;
  /** Z-39: attempt n of m. Absent on older servers: the old "ask your organisation" line shows. */
  retake?: ResultRetakeWire | undefined;
  /** Z-39: Try again button. Shown only when retake.can_retake and the result is not a pass. */
  onRetake?: (() => void) | undefined;
  retaking?: boolean;
  retakeError?: string | null | undefined;
  /** Z-42: marks per section (table under the score). Undefined or empty: no table. Full result page only. */
  sections?: ResultSectionWire[] | undefined;
  /** Z-44: tenant feedback level; shows the same plain sentence as the result email. Undefined or "none": no sentence. */
  feedbackLevel?: string | undefined;
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

/** 42 → "42", 37.5 → "37.5", 66.666 → "66.67" (max `dp` decimals, no trailing zeros). Negatives use a true minus (U+2212). */
function trim(n: number, dp: number): string {
  const v = Number(n.toFixed(dp));
  return v < 0 ? `−${String(-v)}` : String(v);
}

export function ResultSummary({
  totalEarned,
  totalMax,
  percent,
  passed,
  passMark,
  certificate = null,
  negativeMarking,
  compact = false,
  assessmentName,
  tenantName,
  feedbackOn = false,
  retake,
  onRetake,
  retaking = false,
  retakeError = null,
  feedbackLevel,
  sections,
}: ResultSummaryProps): React.ReactElement {
  const feedbackLine = feedbackSentence(feedbackLevel);
  const hasFeedback = feedbackOn || feedbackLine !== null;
  const tone = passed ? 'success' : 'warning';
  const org = tenantName !== undefined && tenantName !== '' ? tenantName : 'your organisation';
  const headline = passed
    ? assessmentName !== undefined && assessmentName !== ''
      ? `You passed ${assessmentName}.`
      : 'You passed.'
    : 'You did not reach the pass mark.';
  const askLine = retakeLine(retake, org);
  const nextStep = passed
    ? certificate !== null
      ? 'Your certificate is ready. Select View certificate to open, download or share it.'
      : null
    : hasFeedback
      ? `Use the feedback on each question to prepare. ${askLine}`
      : askLine;
  // Never --aiq-color-danger: a fail is not an error (Z-9).
  const oneLiner = passed
    ? certificate !== null
      ? 'You passed. View your certificate.'
      : 'You passed.'
    : passMark !== undefined
      ? `Below the pass mark of ${String(passMark)}%.`
      : 'Not passed.';

  return (
    <div>
      {!compact && (
        <div
          data-testid="result-outcome"
          data-outcome={passed ? 'passed' : 'not-passed'}
          style={{
            marginBottom: 20,
            padding: '14px 16px',
            borderLeft: `4px solid var(--aiq-color-${tone})`,
            background: `var(--aiq-color-${tone}-soft)`,
            borderRadius: 'var(--aiq-radius-sm, 6px)',
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>{headline}</div>
          {nextStep !== null && <div style={{ fontSize: 14, marginTop: 6 }}>{nextStep}</div>}
          {!passed && retake?.can_retake === true && onRetake !== undefined && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="aiq-btn aiq-btn-outline"
                data-testid="result-retake"
                data-help-id="candidate.result.retake"
                disabled={retaking}
                onClick={onRetake}
              >
                {retaking ? 'Starting...' : 'Try again'}
              </button>
              {retakeError !== null && (
                <div role="alert" style={{ fontSize: 14, marginTop: 6 }}>
                  {retakeError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
          {/* EX-1: a net-negative score draws as an empty ring; the signed numbers beside it stay exact. */}
          <ScoreRing value={Math.max(0, Math.round(percent))} size={compact ? 'md' : 'lg'} />
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
          {!compact && (
            <div data-testid="result-support" style={{ ...MUTED_14, marginTop: 8 }}>
              {resultSupportLine(passed, trim(totalEarned, 2), trim(totalMax, 2), passMark)}
            </div>
          )}
          {compact && (
            <div data-testid="result-oneliner" style={{ ...MUTED_14, marginTop: 8 }}>
              {oneLiner}
            </div>
          )}
          {feedbackLine !== null && (
            <div data-testid="result-feedback-sentence" style={{ ...MUTED_14, marginTop: 8 }}>
              {feedbackLine}
            </div>
          )}
          {negativeMarking?.enabled === true && (
            <div
              data-help-id="candidate.result.negative_marking"
              style={{ ...MUTED_14, marginTop: 10 }}
            >
              Negative marking: {'−'}{trim(negativeMarking.penalty_total, 2)} deducted for wrong answers
            </div>
          )}
        </div>
      </div>

      {!compact && passMark !== undefined && (
        <div data-testid="result-meter" data-help-id="candidate.result.meter" style={{ marginTop: 20 }}>
          <div
            role="img"
            aria-label={`Your score is ${trim(percent, 1)} percent. The pass mark is ${String(passMark)} percent.`}
            style={{
              position: 'relative',
              height: 8,
              borderRadius: 4,
              background: 'var(--aiq-color-bg-raised)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${String(Math.min(100, Math.max(0, percent)))}%`,
                height: '100%',
                background: `var(--aiq-color-${tone})`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${String(Math.min(100, Math.max(0, passMark)))}%`,
                width: 2,
                background: 'var(--aiq-color-fg-primary)',
              }}
            />
          </div>
          <div style={{ ...EYEBROW, marginTop: 6, marginBottom: 0 }}>0 · Pass mark {String(passMark)}% · 100</div>
        </div>
      )}

      {!compact && (
        <dl
          data-testid="result-stats"
          data-help-id="candidate.result.stats"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 12,
            margin: '16px 0 0',
          }}
        >
          {[
            ['Marks', `${trim(totalEarned, 2)} / ${trim(totalMax, 2)}`],
            ['Percent', `${trim(percent, 1)}%`],
            ...(passMark !== undefined ? [['Pass mark', `${String(passMark)}%`]] : []),
            ...(retake !== undefined ? [['Attempt', `${String(retake.attempt_number)} of ${String(retake.attempts_allowed)}`]] : []),
          ].map(([label, value]) => (
            <div key={label} style={{ border: '1px solid var(--aiq-color-border)', borderRadius: 'var(--aiq-radius-sm, 6px)', padding: '8px 12px' }}>
              <dt style={{ ...EYEBROW, marginBottom: 2 }}>{label}</dt>
              <dd style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!compact && sections !== undefined && sections.length > 0 && (
        <table data-testid="result-sections" style={{ ...MUTED_14, marginTop: 16, borderCollapse: 'collapse', width: '100%' }}>
          <caption style={{ ...EYEBROW, textAlign: 'left' }}>Marks by section</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left', padding: '4px 8px 4px 0' }}>Section</th>
              <th scope="col" style={{ textAlign: 'right', padding: '4px 0' }}>Marks</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <tr key={s.index} style={{ borderTop: '1px solid var(--aiq-color-border)' }}>
                <td style={{ padding: '4px 8px 4px 0', overflowWrap: 'anywhere' }}>
                  {s.name}
                  {s.passed_cutoff !== undefined && s.cutoff_marks !== undefined && (
                    <span data-testid="result-section-cutoff">
                      {' '}
                      ({s.passed_cutoff ? 'qualified' : 'did not qualify'}, cutoff {trim(s.cutoff_marks, 2)})
                    </span>
                  )}
                </td>
                <td style={{ padding: '4px 0', textAlign: 'right' }}>
                  {trim(s.earned, 2)} / {trim(s.max, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {certificate === null && passMark !== undefined && (
        <div style={{ ...MUTED_14, marginTop: compact ? 12 : 16 }}>{certificateRuleText(passMark)}</div>
      )}

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
