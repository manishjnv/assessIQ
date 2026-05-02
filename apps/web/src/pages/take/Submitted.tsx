// Candidate post-submit terminal page.
// Route: /take/attempt/:id/submitted  (registered in App.tsx)
//
// This is a terminal "thank you, results pending" screen. Phase 1 grading is
// admin-initiated (sync-on-click); the result endpoint always returns
// 202 { status: "grading_pending" } for the entire Phase 1 lifetime.
//
// Polling contract:
//   - Initial fetch on mount to confirm the attempt record exists.
//   - 30-second setInterval re-polls while mounted.
//   - If response.status ever !== "grading_pending", the page reloads so React
//     Router can re-route via the Phase 2 result surface (out-of-scope here).
//   - 401/403/404 → Navigate to /take/error (attempt not found or session gone).
//   - 5xx / network errors → still show the submitted panel; polling hiccup
//     should not alarm a candidate who has already submitted.
//
// Layout: single-column centered (terminal state — no further action required).
// Spinner: inline ring, no Spinner primitive shipped yet (see modules/17 SKILL.md).
// Keyframe injection: same idempotent pattern as AutosaveIndicator.tsx.
//
// Anti-patterns (per spec):
//   - No Score / Band / Anchor display — Phase 1 has no grading.
//   - No "Take another assessment" button — /take/dashboard not shipped in Phase 1.
//   - No attempt_events.payload rendering.
//   - No --aiq-color-bg-elevated (renamed to --aiq-color-bg-raised).
//   - No import from AccessIQ_UI_Template (ESLint-forbidden).
//   - No poll interval shorter than 30 seconds.

import { useEffect, useState, type CSSProperties } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { Chip, Card, Logo } from '@assessiq/ui-system';
import { getResult, CandidateApiError } from '@assessiq/candidate-ui';

// ─── keyframe injection (once per page load, SSR-safe) ────────────────────────

const STYLE_ID = 'aiq-submitted-style';

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;

  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent =
    '@keyframes aiq-submitted-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
  document.head.appendChild(el);
}

// ─── page state ───────────────────────────────────────────────────────────────

type PageState =
  | { tag: 'loading' }
  | { tag: 'submitted'; pollError: boolean }
  | { tag: 'redirect' };

// ─── shared style constants ───────────────────────────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

// ─── component ────────────────────────────────────────────────────────────────

export function Submitted(): JSX.Element {
  const { id: attemptId } = useParams<{ id: string }>();
  const [state, setState] = useState<PageState>({ tag: 'loading' });

  // Inject the spin keyframe once on mount, SSR-safe.
  useEffect(() => {
    injectStyles();
  }, []);

  // Initial fetch + polling setup.
  useEffect(() => {
    if (!attemptId) {
      setState({ tag: 'redirect' });
      return;
    }

    let cancelled = false;

    async function poll(isInitial: boolean): Promise<void> {
      try {
        const res = await getResult(attemptId!);
        if (cancelled) return;

        if (res.status !== 'grading_pending') {
          // Phase 2 result available — reload so React Router can re-route.
          window.location.reload();
          return;
        }

        // Still pending — show (or keep showing) the submitted panel, clear
        // any previous poll error.
        setState({ tag: 'submitted', pollError: false });
      } catch (err) {
        if (cancelled) return;

        if (err instanceof CandidateApiError) {
          const { status } = err;
          if (status === 401 || status === 403 || status === 404) {
            // Session gone or attempt not found — redirect to error page.
            setState({ tag: 'redirect' });
            return;
          }
        }

        // 5xx / network — if this is the initial fetch we still show submitted
        // (candidate already submitted; a backend hiccup is not their problem).
        // Mark pollError=true so the sub-text appears.
        if (isInitial) {
          setState({ tag: 'submitted', pollError: true });
        } else {
          // Subsequent poll failure — preserve submitted state, flip pollError.
          setState((prev) =>
            prev.tag === 'submitted' ? { ...prev, pollError: true } : prev,
          );
        }
      }
    }

    // Kick off the initial fetch.
    void poll(true);

    // Schedule 30-second re-polls.
    const intervalId = setInterval(() => {
      void poll(false);
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
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
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 12,
          color: 'var(--aiq-color-fg-muted)',
        }}
      >
        Loading…
      </div>
    );
  }

  // ─── submitted panel ────────────────────────────────────────────────────────

  const { pollError } = state;

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Top bar — slim header */}
      <header
        style={{ padding: '32px 48px', display: 'flex', alignItems: 'center' }}
      >
        <Logo />
      </header>

      {/* Main centered content */}
      <main
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px',
        }}
      >
        <div style={{ width: '100%', maxWidth: 560, textAlign: 'center' }}>
          {/* Status chip */}
          <span style={{ display: 'inline-block', marginBottom: 24 }}>
            <Chip variant="success">Submitted</Chip>
          </span>

          {/* Big serif heading */}
          <h1
            className="aiq-serif"
            style={{
              fontSize: 52,
              lineHeight: 1.05,
              margin: '0 0 16px',
              fontWeight: 400,
              letterSpacing: '-0.025em',
            }}
          >
            Thank you. Your responses are in.
          </h1>

          {/* Body copy */}
          <p
            style={{
              color: 'var(--aiq-color-fg-secondary)',
              fontSize: 17,
              lineHeight: 1.5,
              margin: '0 0 40px',
            }}
          >
            Your attempt has been submitted for review. Results will be released
            once the grading pipeline completes. You can close this tab — we
            will notify the assessment admin automatically.
          </p>

          {/* Grading-pending status box */}
          <Card padding="lg" style={{ textAlign: 'left', marginBottom: 32 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--aiq-space-md)',
              }}
            >
              {/* Inline spinner ring — no Spinner primitive yet per modules/17 SKILL.md */}
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: '2px solid var(--aiq-color-border-strong)',
                  borderTopColor: 'var(--aiq-color-accent)',
                  animation: 'aiq-submitted-spin 800ms linear infinite',
                  flexShrink: 0,
                }}
              />
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Grading pending admin review
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--aiq-color-fg-secondary)',
                  }}
                >
                  {pollError ? (
                    'Result polling temporarily unavailable.'
                  ) : (
                    <>
                      The admin will run the grading pipeline on a synced
                      workstation. You will be notified by email when results
                      are released.
                    </>
                  )}
                </div>
              </div>
            </div>
          </Card>

          {/* Mono attempt-ID footer */}
          <div style={META_LABEL}>Attempt ID · {attemptId}</div>
        </div>
      </main>
    </div>
  );
}
