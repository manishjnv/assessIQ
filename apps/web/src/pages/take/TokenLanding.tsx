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
import { useParams, useNavigate, Link } from 'react-router';
import { Button, Chip, Logo, Spinner, TenantLogo } from '@assessiq/ui-system';
import { takePreview, takeStart, takeCameraConsent, CandidateApiError, CandidateHelp } from '@assessiq/candidate-ui';
import { TakeRightPane } from './TakeRightPane.js';
import { ConsentBlock, PracticeQuestion, SystemCheck, useSystemCheck } from './PreTest.js';
import { ReadinessPanel, useReadiness } from './ReadinessPanel.js';
import { CameraConsent } from './CameraConsent.js';
import { DEVICE_BLOCKED_MESSAGE, collectDeviceSignals, isMobileOrTabletClient } from './readiness.js';

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
  fontSize: 'var(--aiq-text-lg)',
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
      companyLogoUrl: string | null;
      candidateName: string;
      durationSeconds: number;
      questionCount: number;
      passMarkPct: number | null;
      attemptNumber: number | null;
      attemptsAllowed: number | null;
      deliveryMode: 'real' | 'mock' | null;
      /** Z-82: a real exam that needs the camera, and the notice version the candidate must agree to. */
      cameraRequired: boolean;
      cameraNoticeVersion: string | null;
    }
  | { tag: 'error404' }
  | { tag: 'invalid' }
  | { tag: 'error' };

/** Device and readiness signals sent with /take/start. */
type BeginExtra = { device: unknown; readiness: unknown };

// ─── helpers ─────────────────────────────────────────────────────────────────

// ─── right pane lives in TakeRightPane.tsx (shared with Expired + ErrorPage) ──

// ─── left-pane content per state ─────────────────────────────────────────────

export function SuccessContent({
  name,
  company,
  companyLogoUrl = null,
  candidateName,
  durationSeconds,
  questionCount,
  passMarkPct = null,
  attemptNumber = null,
  attemptsAllowed = null,
  deliveryMode = null,
  resumed,
  onBegin,
  beginning,
  beginError,
  cameraRequired = false,
  cameraDeclined = false,
  onAgreeCamera,
  onDecline,
  onBackToStart,
}: {
  name: string;
  company: string;
  companyLogoUrl?: string | null;
  candidateName: string;
  durationSeconds: number;
  questionCount: number;
  /** Z-16: pass mark (1-100); null on older servers. */
  passMarkPct?: number | null;
  /** Z-39: 'Attempt n of m' shows only when the assessment allows more than one attempt. */
  attemptNumber?: number | null;
  attemptsAllowed?: number | null;
  /** Z-89: null = older server (no extra screens). */
  deliveryMode?: 'real' | 'mock' | null;
  resumed: boolean;
  onBegin: (extra?: BeginExtra) => void;
  beginning: boolean;
  beginError: string | null;
  /** Z-82: camera rule for this test, the notice version to agree to, and the declined state. */
  cameraRequired?: boolean;
  cameraDeclined?: boolean;
  onAgreeCamera: (extra?: BeginExtra) => void;
  onDecline: () => void;
  onBackToStart: () => void;
}): React.JSX.Element {
  const totalMinutes = Math.round(durationSeconds / 60);
  const [consent, setConsent] = useState(false);
  const { rows, blocked, recheck } = useSystemCheck();
  // Resume: the attempt (and its clock) already exist, so no consent, practice
  // or system check again, and the timer is NOT restarted.
  // Z-87 / Z-91: a REAL exam needs a laptop or desktop and a passing readiness check; a MOCK runs the
  // same check as an optional dress rehearsal. The server enforces both again at Begin.
  const real = deliveryMode === 'real';
  const mock = deliveryMode === 'mock';
  // Z-82: the camera applies to a new real attempt whose invitation needs it. The camera runs only until Begin.
  const cameraGate = real && cameraRequired && !resumed;
  const cameraActive = cameraGate && !beginning && !cameraDeclined;
  const readiness = useReadiness(deliveryMode !== null && !resumed, cameraGate, cameraActive);
  const deviceBlocked = real && isMobileOrTabletClient(collectDeviceSignals());
  const readyOk = !real || resumed || readiness.passed;
  // The consent screen replaces the checkbox and Begin. It shows after the checks pass, and stays while the answer is sent or declined.
  const cameraConsentShown = cameraGate && !deviceBlocked && (readiness.passed || beginning || cameraDeclined);
  const canBegin = !deviceBlocked && (resumed || (consent && !blocked && readyOk));
  const extra = (): BeginExtra | undefined =>
    deliveryMode !== null && !resumed && readiness.signals !== null
      ? { device: readiness.device, readiness: readiness.signals }
      : undefined;
  const begin = (): void => onBegin(extra());

  return (
    <>
      {(companyLogoUrl !== null || company !== '') && (
        <div data-help-id="candidate.take.landing.logo" style={{ marginBottom: 20 }}>
          <TenantLogo src={companyLogoUrl} name={company} height={40} />
        </div>
      )}
      <span style={{ display: 'inline-block', marginBottom: 20 }}>
        <Chip variant="success">{resumed ? 'Welcome back' : 'Welcome'}</Chip>
        {mock && (
          <span data-help-id="candidate.intro.test_type_mock" style={{ marginLeft: 8 }}>
            <Chip variant="default">Mock test</Chip>
          </span>
        )}
        {real && cameraRequired && (
          <span style={{ marginLeft: 8 }}>
            <Chip variant="default">Real test with camera</Chip>
          </span>
        )}
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
          {passMarkPct !== null && ` · Pass mark ${passMarkPct}%`}
          {attemptNumber !== null && attemptsAllowed !== null && attemptsAllowed > 1 &&
            ` · Attempt ${attemptNumber} of ${attemptsAllowed}`}
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

      {deviceBlocked && (
        <p
          role="alert"
          data-help-id="candidate.intro.device_blocked"
          style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'var(--aiq-color-fg-primary)' }}
        >
          {DEVICE_BLOCKED_MESSAGE}
        </p>
      )}

      {!resumed && !deviceBlocked && deliveryMode !== null && (
        <ReadinessPanel state={readiness} optional={mock} />
      )}

      {!resumed && !deviceBlocked && (
        <>
          {/* RW-26: system check + practice behind one disclosure (native, default closed). */}
          <details open={blocked || undefined} style={{ marginBottom: 16 }}>
            <summary
              style={{
                cursor: 'pointer',
                fontFamily: 'var(--aiq-font-sans)',
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--aiq-color-fg-primary)',
              }}
            >
              {blocked ? 'Test your device' : 'Test your device (optional)'}
            </summary>
            <p style={{ ...META_LABEL, textTransform: 'none', letterSpacing: 0, margin: '8px 0 12px' }}>
              We&rsquo;ll check if your device meets the requirements. Practice a sample question if you want.
            </p>
            <SystemCheck rows={rows} onRecheck={recheck} />
            <PracticeQuestion />
          </details>
          <ConsentBlock
            name={candidateName}
            company={company}
            checked={consent}
            onChange={setConsent}
          />
        </>
      )}

      {cameraConsentShown && (
        <CameraConsent
          organisation={company}
          busy={beginning}
          allowDisabled={!consent || blocked}
          declined={cameraDeclined}
          onAllow={() => onAgreeCamera(extra())}
          onDecline={onDecline}
          onBack={onBackToStart}
        />
      )}

      {beginError !== null && (
        <p
          role="alert"
          style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--aiq-color-fg-primary)' }}
        >
          {beginError}
        </p>
      )}
      {blocked && !resumed && (
        <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--aiq-color-fg-primary)' }}>
          Your device is not ready. Open &quot;Test your device&quot; above to see why.
        </p>
      )}
      {!deviceBlocked && !cameraGate && (
      <Button
        size="lg"
        variant="primary"
        onClick={begin}
        disabled={!canBegin || beginning}
        style={{ width: '100%', justifyContent: 'center' }}
      >
        {beginning ? 'Starting…' : resumed ? 'Resume assessment' : totalMinutes > 0 ? `Begin — your ${totalMinutes}-minute timer starts` : 'Begin'}
      </Button>
      )}
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
        This invitation link is no longer valid.
      </h1>
      <p style={BODY_P}>
        It has expired or a newer invitation replaced it. Ask the person who
        invited you to send a new one, then use the link in your most recent
        email.
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

function ErrorContent({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <>
      <span style={{ display: 'inline-block', marginBottom: 24 }}>
        <Chip variant="accent" leftIcon="bell">Error</Chip>
      </span>
      <h1 className="aiq-serif" style={SERIF_H1}>
        Something went wrong.
      </h1>
      <p style={BODY_P}>
        Please try again. If it keeps happening, ask the person who invited you
        for help.
      </p>
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
  // Z-82: the candidate chose not to start on the camera consent screen.
  const [cameraDeclined, setCameraDeclined] = useState(false);
  // Z-114: tab title "Org name · AssessIQ" once the invitation loads. Restored on unmount.
  const orgTitleName = state.tag === 'success' && state.company !== '' ? state.company : null;
  useEffect(() => {
    if (!orgTitleName) return;
    const prev = document.title;
    document.title = `${orgTitleName} · AssessIQ`;
    return () => {
      document.title = prev;
    };
  }, [orgTitleName]);

  // Read-only: shows the summary WITHOUT creating the attempt or starting the clock.
  const runPreview = useCallback(async (): Promise<void> => {
    if (!token) {
      setState({ tag: 'invalid' });
      return;
    }
    setState({ tag: 'loading' });
    setCameraDeclined(false);
    try {
      const res = await takePreview(token);
      // RW-79: the next screen is the attempt runner; warm its chunk while the candidate reads and consents.
      void import('./Attempt').catch(() => undefined);
      setState({
        tag: 'success',
        resumed: res.resumed,
        name: res.assessment.name,
        company: res.assessment.company_name,
        companyLogoUrl: res.assessment.company_logo_url ?? null,
        candidateName: res.candidate.name,
        durationSeconds: res.assessment.duration_seconds,
        questionCount: res.assessment.question_count,
        // pass_mark_pct is not in the shared wire type yet (module 11 is edited elsewhere).
        passMarkPct: (res.assessment as { pass_mark_pct?: number }).pass_mark_pct ?? null,
        attemptNumber: res.assessment.attempt_number ?? null,
        attemptsAllowed: res.assessment.attempts_allowed ?? null,
        deliveryMode: res.assessment.delivery_mode ?? null,
        cameraRequired: res.assessment.camera_required === true,
        cameraNoticeVersion: res.assessment.camera_notice_version ?? null,
      });
    } catch (err) {
      if (err instanceof CandidateApiError) {
        if (err.status === 404) {
          setState({ tag: 'error404' });
        } else if (err.status === 401 || err.status === 403) {
          setState({ tag: 'invalid' });
        } else {
          setState({ tag: 'error' });
        }
      } else {
        setState({ tag: 'error' });
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
  const beginErrorText = (err: unknown): string => {
    const code = err instanceof CandidateApiError ? err.apiError.code : '';
    if (code === 'DEVICE_NOT_ALLOWED') return DEVICE_BLOCKED_MESSAGE;
    if (code === 'READINESS_FAILED')
      return 'Your device is not ready for this test. Run the readiness check again and fix any item marked Fix needed.';
    if (code === 'CAMERA_SETUP_REQUIRED')
      return err instanceof CandidateApiError && err.apiError.message !== ''
        ? err.apiError.message
        : 'The test organiser has not finished the camera set-up. Contact your test organiser.';
    if (code === 'CAMERA_CONSENT_REQUIRED') return 'Please choose Allow camera and start to continue.';
    if (err instanceof CandidateApiError && err.status === 422) return 'Please accept the consent statement to begin.';
    if (err instanceof CandidateApiError && (err.status === 404 || err.status === 410))
      return 'This invitation link is no longer valid. Ask the person who invited you to send a new one, then use the link in your most recent email.';
    return 'We could not start your assessment. Check your connection and try again.';
  };

  // A stale camera notice reloads the preview so the candidate reads the new text. Other errors show a message.
  const handleFailure = (err: unknown): void => {
    setBeginning(false);
    const code = err instanceof CandidateApiError ? err.apiError.code : '';
    if (code === 'CAMERA_NOTICE_STALE') {
      void runPreview();
      return;
    }
    setBeginError(beginErrorText(err));
  };

  const startAttempt = async (extra?: BeginExtra): Promise<void> => {
    if (state.tag !== 'success' || !token) return;
    try {
      const res = await takeStart(token, {
        consent: !state.resumed,
        ...(extra !== undefined ? { device: extra.device, readiness: extra.readiness } : {}),
      });
      navigate(`/take/attempt/${res.attempt_id}`);
    } catch (err) {
      handleFailure(err);
    }
  };

  const handleBegin = async (extra?: BeginExtra): Promise<void> => {
    if (state.tag !== 'success' || !token || beginning) return;
    setBeginning(true);
    setBeginError(null);
    await startAttempt(extra);
  };

  // Z-82: Allow records the agreed decision, then starts. The camera stops because beginning is true.
  const handleAgreeCamera = async (extra?: BeginExtra): Promise<void> => {
    if (state.tag !== 'success' || !token || beginning) return;
    setBeginning(true);
    setBeginError(null);
    try {
      await takeCameraConsent(token, 'agreed', state.cameraNoticeVersion ?? '');
    } catch (err) {
      handleFailure(err);
      return;
    }
    await startAttempt(extra);
  };

  // Z-82: a declined answer is recorded. The test does not start and the invitation stays valid.
  const handleDeclineCamera = async (): Promise<void> => {
    if (state.tag !== 'success' || !token || beginning) return;
    setBeginning(true);
    setBeginError(null);
    try {
      await takeCameraConsent(token, 'declined', state.cameraNoticeVersion ?? '');
    } catch (err) {
      handleFailure(err);
      return;
    }
    setBeginning(false);
    setCameraDeclined(true);
  };

  let leftContent: React.JSX.Element;
  if (state.tag === 'success') {
    leftContent = (
      <SuccessContent
        name={state.name}
        company={state.company}
        companyLogoUrl={state.companyLogoUrl}
        candidateName={state.candidateName}
        durationSeconds={state.durationSeconds}
        questionCount={state.questionCount}
        passMarkPct={state.passMarkPct}
        attemptNumber={state.attemptNumber}
        attemptsAllowed={state.attemptsAllowed}
        deliveryMode={state.deliveryMode}
        resumed={state.resumed}
        onBegin={(extra) => void handleBegin(extra)}
        beginning={beginning}
        beginError={beginError}
        cameraRequired={state.cameraRequired}
        cameraDeclined={cameraDeclined}
        onAgreeCamera={(extra) => void handleAgreeCamera(extra)}
        onDecline={() => void handleDeclineCamera()}
        onBackToStart={() => void runPreview()}
      />
    );
  } else if (state.tag === 'error404') {
    leftContent = <Error404Content />;
  } else if (state.tag === 'invalid') {
    leftContent = <InvalidContent />;
  } else {
    leftContent = (
      <ErrorContent onRetry={() => void runPreview()} />
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
