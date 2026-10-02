// Candidate magic-link landing page. Ported from the two-column layout idiom
// in apps/web/src/pages/admin/login.tsx (itself ported from
// modules/17-ui-system/AssessIQ_UI_Template/screens/login.jsx).
//
// Route: /take/:token  (registered in App.tsx by Opus)
//
// State machine:
//   loading  → takePreview in flight (read-only: NO attempt, NO timer)
//   success  → pre-test screen (summary, system check, practice, consent). The
//              Begin click calls takeStart({consent}) which creates the attempt
//              (the clock starts there) → navigate to /take/attempt/:attempt_id
//   error404 → link not found
//   invalid  → 401 / 403 → expired / revoked link
//   error    → 5xx / network / unknown
//
// Anti-pattern notes:
//   - Token is NOT stored in localStorage (one-time credential; server marks
//     it consumed on success — cookie-only path is the contract).
//   - No dark-mode variants (SPA pins theme="light").
//   - No "Pause" / "Save & continue later" (the attempt is session-only).
//   - --aiq-color-bg-raised is the canonical token; --aiq-color-bg-elevated
//     is the old name and must not appear in new code.

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button, Chip, Logo, Spinner } from '@assessiq/ui-system';
import { takePreview, takeStart, CandidateApiError, CandidateHelp } from '@assessiq/candidate-ui';
import { TakeRightPane } from './TakeRightPane.js';
import { ConsentBlock, PracticeQuestion, SystemCheck, useSystemCheck } from './PreTest.js';

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
  | {
      tag: 'success';
      resumed: boolean;
      name: string;
      company: string;
      candidateName: string;
      durationSeconds: number;
      questionCount: number;
    }
  | { tag: 'error404' }
  | { tag: 'invalid' }
  | { tag: 'error'; message: string };

// ─── helpers ─────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── right pane lives in TakeRightPane.tsx (shared with Expired + ErrorPage) ──

// ─── left-pane content per state ─────────────────────────────────────────────

export function SuccessContent({
  name,
  company,
  candidateName,
  durationSeconds,
  questionCount,
  resumed,
  onBegin,
  beginning,
  beginError,
}: {
  name: string;
  company: string;
  candidateName: string;
  durationSeconds: number;
  questionCount: number;
  resumed: boolean;
  onBegin: () => void;
  beginning: boolean;
  beginError: string | null;
}): React.JSX.Element {
  const totalMinutes = Math.round(durationSeconds / 60);
  const [consent, setConsent] = useState(false);
  const { rows, blocked, recheck } = useSystemCheck();
  // Resume: the attempt (and its clock) already exist, so no consent, practice
  // or system check again, and the timer is NOT restarted.
  const canBegin = resumed || (consent && !blocked);

  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 20 }}>
        <Chip variant="success">{resumed ? 'Welcome back' : 'Welcome'}</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        {resumed ? 'Pick up where you left off.' : 'Ready when you are.'}
      </h1>

      {/* ── Summary + rules ──────────────────────────────────────────── */}
      <div
        data-help-id="candidate.intro.integrity"
        style={{
          marginBottom: 16,
          padding: '14px 16px',
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
            margin: '0 0 4px',
            color: 'var(--aiq-color-fg-primary)',
          }}
        >
          {name}
        </h2>
        <p style={{ ...META_LABEL, margin: '0 0 10px' }}>
          {company ? `${company} · ` : ''}
          {totalMinutes} min · {questionCount} question{questionCount !== 1 ? 's' : ''}
        </p>
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 13,
            color: 'var(--aiq-color-fg-secondary)',
            lineHeight: 1.6,
          }}
        >
          <li>
            {resumed
              ? 'Your timer is already running. It did not pause while you were away.'
              : 'The timer starts when you click Begin and cannot be paused.'}
          </li>
          <li>Your answers save automatically. You do not need to save anything.</li>
          <li>If your connection drops, open this link again to continue.</li>
          <li>After you submit, you cannot change your answers.</li>
        </ul>
        <div style={{ marginTop: 8 }}>
          <CandidateHelp triggerLabel="Need more help?" />
        </div>
      </div>

      {!resumed && (
        <>
          <SystemCheck rows={rows} onRecheck={recheck} />
          <PracticeQuestion />
          <ConsentBlock
            name={candidateName}
            company={company}
            checked={consent}
            onChange={setConsent}
          />
        </>
      )}

      {beginError !== null && (
        <p
          role="alert"
          style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--aiq-color-fg-primary)' }}
        >
          {beginError}
        </p>
      )}
      <Button
        size="lg"
        variant="primary"
        onClick={onBegin}
        disabled={!canBegin || beginning}
        style={{ width: '100%', justifyContent: 'center' }}
      >
        {beginning ? 'Starting…' : resumed ? 'Resume assessment' : 'Begin assessment'}
      </Button>
    </>
  );
}

function Error404Content(): React.JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Error</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        We couldn't open this link.
      </h1>
      <p style={BODY_P}>
        This link may have expired, or a newer invitation email may have
        replaced it. Check that you copied the whole link and use the link in
        your most recent email. If it still won&rsquo;t open, ask the person who
        invited you to resend your invitation.
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

function InvalidContent(): React.JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Invalid</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Invalid magic link.
      </h1>
      <p style={BODY_P}>
        This link has expired or was replaced by a newer invitation. Ask the
        person who invited you to resend it, then use the link in your most
        recent email.
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
}): React.JSX.Element {
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

// ─── main component ───────────────────────────────────────────────────────────

export function TokenLanding(): React.JSX.Element {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ tag: 'loading' });
  const [beginning, setBeginning] = useState(false);
  const [beginError, setBeginError] = useState<string | null>(null);

  // Read-only: shows the summary WITHOUT creating the attempt or starting the clock.
  const runPreview = useCallback(async (): Promise<void> => {
    if (!token) {
      setState({ tag: 'invalid' });
      return;
    }
    setState({ tag: 'loading' });
    try {
      const res = await takePreview(token);
      setState({
        tag: 'success',
        resumed: res.resumed,
        name: res.assessment.name,
        company: res.assessment.company_name,
        candidateName: res.candidate.name,
        durationSeconds: res.assessment.duration_seconds,
        questionCount: res.assessment.question_count,
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
    void runPreview();
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

  // The Begin click is the ONLY thing that creates the attempt / starts the clock.
  const handleBegin = async (): Promise<void> => {
    if (state.tag !== 'success' || !token || beginning) return;
    setBeginning(true);
    setBeginError(null);
    try {
      const res = await takeStart(token, { consent: !state.resumed });
      navigate(`/take/attempt/${res.attempt_id}`);
    } catch (err) {
      setBeginning(false);
      setBeginError(
        err instanceof CandidateApiError && err.status === 422
          ? 'Please accept the consent statement to begin.'
          : err instanceof CandidateApiError && (err.status === 404 || err.status === 410)
            ? 'This link has expired or was replaced. Ask the person who invited you to resend your invitation, then use the link in your most recent email.'
            : 'We could not start your test. Check your connection and try again.',
      );
    }
  };

  let leftContent: React.JSX.Element;
  if (state.tag === 'success') {
    leftContent = (
      <SuccessContent
        name={state.name}
        company={state.company}
        candidateName={state.candidateName}
        durationSeconds={state.durationSeconds}
        questionCount={state.questionCount}
        resumed={state.resumed}
        onBegin={() => void handleBegin()}
        beginning={beginning}
        beginError={beginError}
      />
    );
  } else if (state.tag === 'error404') {
    leftContent = <Error404Content />;
  } else if (state.tag === 'invalid') {
    leftContent = <InvalidContent />;
  } else {
    leftContent = (
      <ErrorContent message={state.message} onRetry={() => void runPreview()} />
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
          <div style={{ width: '100%', maxWidth: 440 }}>{leftContent}</div>
        </div>

        {/* Legal links — trust signal + DPDP transparency for candidates.
            Plain <a> so it loads the marketing-served /privacy and /terms. */}
        <p
          style={{
            marginTop: 24,
            fontSize: 12,
            color: 'var(--aiq-color-fg-muted)',
            fontFamily: 'var(--aiq-font-sans)',
          }}
        >
          <a href="/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>
            Privacy
          </a>
          {' · '}
          <a href="/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>
            Terms
          </a>
        </p>
      </main>

      <TakeRightPane />
    </div>
  );
}
