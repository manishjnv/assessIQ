// Candidate magic-link landing page. Ported from the two-column layout idiom
// in apps/web/src/pages/admin/login.tsx (itself ported from
// modules/17-ui-system/AssessIQ_UI_Template/screens/login.jsx).
//
// Route: /take/:token  (registered in App.tsx by Opus)
//
// State machine:
//   loading  → API call in flight
//   success  → takeStart resolved  → navigate to /take/attempt/:attempt_id
//   error404 → backend not yet wired (Session 4b deliverable)
//   invalid  → 401 / 403 → expired / revoked link
//   error    → 5xx / network / unknown
//
// Anti-pattern notes:
//   - Token is NOT stored in localStorage (one-time credential; server marks
//     it consumed on success — cookie-only path is the contract).
//   - No dark-mode variants (SPA pins theme="light").
//   - No "Pause" / "Save & continue later" (Phase 1 is session-only).
//   - --aiq-color-bg-raised is the canonical token; --aiq-color-bg-elevated
//     is the old name and must not appear in new code.

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button, Chip, Logo, Spinner } from '@assessiq/ui-system';
import { takeStart, CandidateApiError, CandidateHelp } from '@assessiq/candidate-ui';
import { TakeRightPane } from './TakeRightPane.js';

// ─── shared style constants (mirrors login.tsx) ───────────────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const SERIF_H1: CSSProperties = {
  // CSS vars cascade from .aiq-take-twopane outer div (see tokens.css).
  // Desktop 44/1.05; mobile 30/1.1 — M1 phase of MOBILE_KIT_PORT.
  fontSize: 'var(--aiq-take-h1-size, 44px)',
  lineHeight: 'var(--aiq-take-h1-lh, 1.05)',
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

const BODY_P: CSSProperties = {
  color: 'var(--aiq-color-fg-secondary)',
  fontSize: 15,
  margin: '0 0 32px',
  lineHeight: 1.5,
};

// ─── types ────────────────────────────────────────────────────────────────────

type PageState =
  | { tag: 'loading' }
  | { tag: 'success'; attemptId: string; name: string; durationSeconds: number }
  | { tag: 'error404' }
  | { tag: 'invalid' }
  | { tag: 'error'; message: string };

// ─── helpers ─────────────────────────────────────────────────────────────────

function _formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── right pane lives in TakeRightPane.tsx (shared with Expired + ErrorPage) ──

// ─── left-pane content per state ─────────────────────────────────────────────

function _LoadingContent(): JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="default">Loading</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Loading…
      </h1>
      <p style={BODY_P}>Verifying your invitation. This takes just a moment.</p>
    </>
  );
}

function SuccessContent({
  name,
  durationSeconds,
  onBegin,
}: {
  name: string;
  durationSeconds: number;
  onBegin: () => void;
}): JSX.Element {
  const totalMinutes = Math.round(durationSeconds / 60);

  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="success">Welcome</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Ready when you are.
      </h1>

      {/* ── Before you begin ─────────────────────────────────────────── */}
      <div
        data-help-id="candidate.intro.integrity"
        style={{
          marginBottom: 28,
          padding: '16px 20px',
          border: '1px solid var(--aiq-color-border)',
          borderRadius: 'var(--aiq-radius-md)',
          background: 'var(--aiq-color-bg-raised)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 14,
            fontWeight: 600,
            margin: '0 0 12px',
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          Before you begin
        </h2>
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 14,
            color: 'var(--aiq-color-fg-secondary)',
            lineHeight: 1.6,
          }}
        >
          <li style={{ marginBottom: 6 }}>
            <strong>{name}</strong> takes about {totalMinutes} minute{totalMinutes !== 1 ? 's' : ''}.
            Once you begin, the timer starts and cannot be paused.
          </li>
          <li style={{ marginBottom: 6 }}>
            Your answers save automatically as you type. You don't need to click
            Save anywhere.
          </li>
          <li style={{ marginBottom: 6 }}>
            If your browser crashes or your internet drops, just open this link
            again — you'll resume where you left off.
          </li>
          <li>
            Once you click Submit at the end, you can't change your answers.
          </li>
        </ul>
        <div style={{ marginTop: 12 }}>
          <CandidateHelp triggerLabel="Need more help?" />
        </div>
      </div>

      <Button
        size="lg"
        variant="primary"
        onClick={onBegin}
        style={{ width: '100%', justifyContent: 'center' }}
      >
        Begin assessment
      </Button>
    </>
  );
}

function Error404Content(): JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Error</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Connection error.
      </h1>
      <p style={BODY_P}>
        The magic-link backend is not yet live in this environment. (Session 4b
        deliverable.)
      </p>
      <Link
        to="/"
        style={{ textDecoration: 'none', display: 'inline-block', width: '100%' }}
      >
        <Button
          size="lg"
          variant="outline"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Return to home
        </Button>
      </Link>
    </>
  );
}

function InvalidContent(): JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Invalid</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Invalid magic link.
      </h1>
      <p style={BODY_P}>
        This link is no longer valid. Ask your assessment admin to send a new
        invitation.
      </p>
      <Link
        to="/"
        style={{ textDecoration: 'none', display: 'inline-block', width: '100%' }}
      >
        <Button
          size="lg"
          variant="outline"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Return to home
        </Button>
      </Link>
    </>
  );
}

function ErrorContent({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Error</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Something went wrong.
      </h1>
      <p style={BODY_P}>{truncate(message, 200)}</p>
      <Button
        size="lg"
        variant="outline"
        onClick={onRetry}
        style={{ width: '100%', justifyContent: 'center' }}
      >
        Try again
      </Button>
    </>
  );
}

// ─── chip variant per state (for the left pane top chip) ─────────────────────

// Note: individual content components render their own chip above — this
// mapping is not used at runtime but documents the intent for reviewers.
// loading → variant="default"  | success → variant="success"
// error404/invalid/error → variant="accent" leftIcon="bell"

// ─── main component ───────────────────────────────────────────────────────────

export function TokenLanding(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ tag: 'loading' });

  const runTakeStart = useCallback(async (): Promise<void> => {
    if (!token) {
      setState({ tag: 'invalid' });
      return;
    }
    setState({ tag: 'loading' });
    try {
      const res = await takeStart(token);
      setState({
        tag: 'success',
        attemptId: res.attempt_id,
        name: res.assessment.name,
        durationSeconds: res.assessment.duration_seconds,
      });
    } catch (err) {
      if (err instanceof CandidateApiError) {
        if (err.status === 404) {
          setState({ tag: 'error404' });
        } else if (err.status === 401 || err.status === 403) {
          setState({ tag: 'invalid' });
        } else {
          setState({
            tag: 'error',
            message: err.apiError?.message ?? `HTTP ${err.status}`,
          });
        }
      } else if (err instanceof Error) {
        setState({ tag: 'error', message: err.message });
      } else {
        setState({ tag: 'error', message: 'Unknown error. Please try again.' });
      }
    }
  }, [token]);

  useEffect(() => {
    void runTakeStart();
  }, []);

  // Loading: spinner centered — Spinner primitive from Phase 3a.
  if (state.tag === 'loading') {
    return (
      <div
        className="aiq-screen"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}
      >
        <Spinner aria-label="Verifying invitation" />
      </div>
    );
  }

  const handleBegin = (): void => {
    if (state.tag === 'success') {
      navigate(`/take/attempt/${state.attemptId}`);
    }
  };

  let leftContent: JSX.Element;
  if (state.tag === 'success') {
    leftContent = (
      <SuccessContent
        name={state.name}
        durationSeconds={state.durationSeconds}
        onBegin={handleBegin}
      />
    );
  } else if (state.tag === 'error404') {
    leftContent = <Error404Content />;
  } else if (state.tag === 'invalid') {
    leftContent = <InvalidContent />;
  } else {
    leftContent = (
      <ErrorContent message={state.message} onRetry={() => void runTakeStart()} />
    );
  }

  return (
    <div
      className="aiq-screen aiq-take-twopane"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gap: 0,
      }}
    >
      <main
        className="aiq-take-main"
        style={{
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Logo />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '100%', maxWidth: 380 }}>{leftContent}</div>
        </div>
      </main>

      <TakeRightPane />
    </div>
  );
}
