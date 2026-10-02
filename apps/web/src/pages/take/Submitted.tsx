// Candidate post-submit page.
// Route: /take/attempt/:id/submitted  (registered in App.tsx)
//
// Scoring + result release (owner rules P1/P2, spec 2026-10-01 §3):
//   - A candidate sees ONLY a complete, final result — never a partial or
//     provisional score, never per-question data, bands or AI justifications.
//   - What to expect comes from the submit response (Attempt.tsx hands it over
//     as router state) or, when absent (timer-expiry auto-submit, deep link,
//     reload without state), from GET /result:
//       'soon'  → "Scoring your answers…" and poll GET /result every 5 s for at
//                 most 60 s; a 200 `released` swaps in the result card.
//       'email' → "Your result will be emailed to {email_masked} {turnaround}."
//                 (manual-release tenants: "…once {tenant} releases it.")
//   - After the 60 s window the page settles on the email message. A 5xx or
//     network error while polling never alarms a candidate who already
//     submitted — it just keeps trying until the window closes.
//   - 401/403/404 on the FIRST fetch, with no router state to show → /take/error.
//
// Layout: single-column centered (terminal state — nothing more to do).
// Mobile: .aiq-submitted-* classes (tokens.css, M3) keep chrome padding + h1
// size viewport-aware; the result card reflows via flex-wrap (no viewport branch).
//
// Anti-patterns (per spec):
//   - No band / anchor / AI-justification display (P1) — total, percent,
//     pass/fail and certificate link only.
//   - No "Take another assessment" button — /take/dashboard not shipped.
//   - No attempt_events.payload rendering.
//   - No import from AssessIQ_UI_Template (ESLint-forbidden).

import { useEffect, useState, type CSSProperties } from 'react';
import { useParams, useLocation, Navigate } from 'react-router-dom';
import { Chip, Card, Logo, Spinner } from '@assessiq/ui-system';
import {
  getResult,
  CandidateApiError,
  ResultSummary,
} from '@assessiq/candidate-ui';
import type {
  AttemptResultReleasedWire,
  ResultExpectation,
} from '@assessiq/candidate-ui';

// ─── polling window (P2: ~1 minute) ───────────────────────────────────────────

const POLL_MS = 5_000;
const POLL_MAX_MS = 60_000;

// ─── page state ───────────────────────────────────────────────────────────────

/** Everything the "pending" copy needs; every text field may be unknown. */
interface Pending {
  expectation: ResultExpectation;
  emailMasked: string | null;
  turnaroundText: string | null;
  tenantName: string | null;
  /** True only when the API says the tenant releases results manually. */
  manual: boolean;
}

type PageState =
  | { tag: 'loading' }
  | { tag: 'scoring'; info: Pending }
  | { tag: 'email'; info: Pending }
  | { tag: 'released'; result: AttemptResultReleasedWire; emailMasked: string | null }
  | { tag: 'redirect' };

// Used when we know nothing (old API, first fetch failed): the email message
// without an address is true in every case.
const UNKNOWN: Pending = {
  expectation: 'email',
  emailMasked: null,
  turnaroundText: null,
  tenantName: null,
  manual: false,
};

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Reads the pending fields from the submit response (router state) or a 202
 * body. Returns null when `result_expectation` is missing — e.g. router state
 * is absent, `{}`, or the server still answers `grading_pending`.
 */
function toPending(src: unknown): Pending | null {
  if (typeof src !== 'object' || src === null) return null;
  const o = src as Record<string, unknown>;
  const expectation = o['result_expectation'];
  if (expectation !== 'soon' && expectation !== 'email') return null;
  return {
    expectation,
    emailMasked: text(o['email_masked']),
    turnaroundText: text(o['turnaround_text']),
    tenantName: text(o['tenant_name']),
    manual: o['release_mode'] === 'manual',
  };
}

function emailSentence(info: Pending): string {
  const to = info.emailMasked ?? 'your registered email address';
  const when = info.manual
    ? `once ${info.tenantName ?? 'your organisation'} releases it`
    : (info.turnaroundText?.replace(/[.\s]+$/, '') ?? "as soon as it's ready");
  return `Your result will be emailed to ${to} ${when}.`;
}

// ─── shared style constants ───────────────────────────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const SUB_TEXT: CSSProperties = {
  fontSize: 13,
  color: 'var(--aiq-color-fg-secondary)',
};

// ─── component ────────────────────────────────────────────────────────────────

export function Submitted(): React.JSX.Element {
  const { id: attemptId } = useParams<{ id: string }>();
  const location = useLocation();

  // Submit response handed over by Attempt.tsx; null when there is none.
  const [seed] = useState<Pending | null>(() => toPending(location.state));
  const [state, setState] = useState<PageState>(() =>
    seed === null
      ? { tag: 'loading' }
      : seed.expectation === 'soon'
        ? { tag: 'scoring', info: seed }
        : { tag: 'email', info: seed },
  );

  // First check on mount, then (only while scoring) every POLL_MS until the
  // POLL_MAX_MS window closes.
  useEffect(() => {
    if (!attemptId) {
      setState({ tag: 'redirect' });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + POLL_MAX_MS;
    let info: Pending | null = seed; // best knowledge so far

    // Keep polling while the API says 'soon' and the window is open; otherwise
    // settle on the email message.
    function next(): void {
      const cur = info ?? UNKNOWN;
      if (cur.expectation === 'soon' && Date.now() < deadline) {
        timer = setTimeout(() => void check(false), POLL_MS);
      } else {
        setState({ tag: 'email', info: cur });
      }
    }

    async function check(first: boolean): Promise<void> {
      try {
        const res = await getResult(attemptId!);
        if (cancelled) return;

        if (res.status === 'released') {
          setState({
            tag: 'released',
            result: res,
            emailMasked: info?.emailMasked ?? null,
          });
          return;
        }

        info = toPending(res) ?? info;
        const cur = info ?? UNKNOWN;
        if (cur.expectation === 'soon' && Date.now() < deadline) {
          setState({ tag: 'scoring', info: cur });
        }
        next();
      } catch (err) {
        if (cancelled) return;

        // Session gone / attempt not found, and nothing to show: error page.
        if (
          first &&
          seed === null &&
          err instanceof CandidateApiError &&
          (err.status === 401 || err.status === 403 || err.status === 404)
        ) {
          setState({ tag: 'redirect' });
          return;
        }

        // 5xx / network / mid-poll auth blip: not the candidate's problem.
        next();
      }
    }

    void check(true);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Runs once per attempt — `seed` is fixed for the page lifetime.
  }, [attemptId]);

  // ─── redirect state ─────────────────────────────────────────────────────────

  if (state.tag === 'redirect') {
    return <Navigate to="/take/error" replace />;
  }

  // ─── loading state ──────────────────────────────────────────────────────────

  if (state.tag === 'loading') {
    return (
      <div
        className="aiq-screen"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}
      >
        <Spinner aria-label="Loading submission status" />
      </div>
    );
  }

  // ─── page ───────────────────────────────────────────────────────────────────

  const released = state.tag === 'released';

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Top bar — slim header */}
      <header
        className="aiq-submitted-header"
        style={{ display: 'flex', alignItems: 'center' }}
      >
        <Logo />
      </header>

      {/* Main centered content */}
      <main
        className="aiq-submitted-main"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: '100%', maxWidth: 560, textAlign: 'center' }}>
          {/* Status chip */}
          <span style={{ display: 'inline-block', marginBottom: 24 }}>
            <Chip variant="success">{released ? 'Completed' : 'Submitted'}</Chip>
          </span>

          {/* Big serif heading — fontSize + lineHeight via class for viewport-aware
              sizing (M3); margin/fontWeight/letterSpacing remain inline. */}
          <h1
            className="aiq-serif aiq-submitted-h1"
            style={{
              margin: '0 0 32px',
              fontWeight: 400,
              letterSpacing: '-0.025em',
            }}
          >
            {released ? 'Your result is ready.' : 'Thank you. Your responses are in.'}
          </h1>

          {/* The swap between scoring / email / result is announced politely. */}
          <div aria-live="polite">
            {state.tag === 'released' ? (
              <>
                <Card
                  data-help-id="candidate.result.bands"
                  padding="lg"
                  style={{ textAlign: 'left', marginBottom: 16 }}
                >
                  <div style={{ ...META_LABEL, marginBottom: 20, overflowWrap: 'anywhere' }}>
                    {state.result.assessment_name}
                  </div>
                  <ResultSummary
                    totalEarned={state.result.total_earned}
                    totalMax={state.result.total_max}
                    percent={state.result.percent}
                    passed={state.result.passed}
                    certificate={state.result.certificate}
                  />
                </Card>
                {state.emailMasked !== null && (
                  <p style={{ ...SUB_TEXT, margin: '0 0 32px' }}>
                    A copy was emailed to {state.emailMasked}.
                  </p>
                )}
              </>
            ) : (
              <Card
                data-help-id="candidate.submit.confirm"
                padding="lg"
                style={{ textAlign: 'left', marginBottom: 32 }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--aiq-space-md)',
                  }}
                >
                  {state.tag === 'scoring' && (
                    <Spinner
                      size="sm"
                      aria-label="Scoring your answers"
                      style={{ flexShrink: 0 }}
                    />
                  )}
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {state.tag === 'scoring'
                        ? 'Scoring your answers… this takes under a minute.'
                        : emailSentence(state.info)}
                    </div>
                    <div style={SUB_TEXT}>
                      {state.tag === 'scoring'
                        ? 'Please keep this page open — your result will appear here.'
                        : 'You can close this page. Nothing more is needed from you.'}
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </div>

          {/* Mono attempt-ID footer */}
          <div style={META_LABEL}>Attempt ID · {attemptId}</div>
        </div>
      </main>
    </div>
  );
}
