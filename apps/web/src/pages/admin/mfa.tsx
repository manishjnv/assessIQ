// Admin MFA — TOTP enrolment + verification.
//
// Ported from modules/17-ui-system/AssessIQ_UI_Template/screens/mfa.jsx
// per the canonical-template rule in docs/10-branding-guideline.md § 0.
//
// Translation notes (intentional divergences from screens/mfa.jsx):
//
// 1. NO design-canvas mode toggle — the template's top bar carries
//    enroll/verify/lockout buttons for the design canvas only. Live
//    routing decides the mode from API responses (409 ALREADY_ENROLLED
//    → verify, 423 → lockout, otherwise enrol).
//
// 2. NO Logo or top-bar in the live page — the SPA shell currently
//    has no global header (App.tsx renders routes only). Phase 1+
//    will add an admin shell with Logo + nav; until then the centred
//    card stands on its own. The mono page footer IS preserved
//    (template idiom).
//
// 3. Recovery-code link only shown on verify mode — matches template
//    behaviour. Hidden on enrol because no recovery codes exist yet.
//
// 4. QR is rendered into a real <canvas> via the qrcode library
//    instead of the template's <Placeholder /> — the placeholder is
//    a designer-tool stand-in; the live canvas is the actual scan
//    target. Same surface background + radius + manual-entry mono
//    microcopy beneath, matching screens/mfa.jsx structurally.
//
// 5. The lockout (423) state is a transient form-level error message,
//    not the dedicated mode the template demos. The button label and
//    field-error styling match the template's lockout idiom; future
//    hardening could surface a separate "locked until <time>" panel.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, Chip } from '@assessiq/ui-system';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, ApiCallError } from '../../lib/api';
import { fetchWhoami, useSession } from '../../lib/session';

interface EnrollStartResponse {
  otpauthUri: string;
  secretBase32: string;
}

interface EnrollConfirmResponse {
  recoveryCodes: string[];
}

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

export function AdminMfa(): JSX.Element {
  const { session, loading } = useSession();
  const nav = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [secretBase32, setSecretBase32] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryCodesCopied, setRecoveryCodesCopied] = useState(false);
  const [recoveryCodesSaved, setRecoveryCodesSaved] = useState(false);

  // Decide enrol vs verify from the AUTHORITATIVE session.totpEnrolled
  // (whoami computes it from user_credentials.totp_enrolled_at). The prior
  // heuristic — "call enroll/start; 409 ALREADY_ENROLLED ⇒ verify" — was
  // broken: enrollStart has NO already-enrolled guard and never returns 409,
  // so an already-enrolled user was shown a fresh QR (new secret) on EVERY
  // login and could never verify — "invalid totp code" because their
  // authenticator holds the persisted secret while confirm validates the new
  // Redis-staged one. Masked until super_admin (always-MFA) hit /admin/mfa;
  // MFA_REQUIRED=false makes normal admins skip this page entirely.
  // (2026-05-17 RCA — "re-enrol MFA every login".)
  useEffect(() => {
    if (loading || session === null) return;
    if (session.mfaStatus === 'verified') {
      // Already MFA-verified — skip ahead to the dashboard.
      // /admin is the canonical post-login landing (changed 2026-05-04;
      // MFA page intentionally does NOT use AdminShell — it is a
      // constrained-flow step that runs pre-verified-session; the
      // sidebar would expose nav links the user cannot access yet).
      nav('/admin', { replace: true });
      return;
    }

    if (session.totpEnrolled === true) {
      // Already enrolled → VERIFY with the persisted secret. Must NOT call
      // enroll/start: that stages a brand-new secret and enroll/confirm would
      // overwrite user_credentials, permanently desyncing the authenticator.
      setEnrolled(true);
      return;
    }

    // Not enrolled (totpEnrolled false/absent) → first-time enrolment.
    let cancelled = false;
    api<EnrollStartResponse>('/auth/totp/enroll/start', { method: 'POST' })
      .then((data) => {
        if (cancelled) return;
        setSecretBase32(data.secretBase32);
        setOtpauthUri(data.otpauthUri);
        setEnrolled(false);
        // QR is drawn by the dedicated effect below — NOT here. The <canvas>
        // only mounts once enrolled===false re-renders, so canvasRef.current
        // is still null at this point (fixed 2026-05-17: super-admin saw a
        // blank QR with only the manual key; the inline toCanvas never ran).
      })
      .catch((err: unknown) => {
        if (err instanceof ApiCallError) {
          // Defensive: honour a 409 if enrollStart ever gains the guard.
          if (err.status === 409 || err.apiError.code === 'ALREADY_ENROLLED') {
            setEnrolled(true);
          } else {
            setError(err.apiError.message);
          }
        } else {
          setError('Could not start TOTP enrolment.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loading, session, nav]);

  // Draw the QR once the <canvas> is actually in the DOM. The canvas is
  // conditionally rendered (enrolled===false && !locked), so it does not
  // exist when enroll/start resolves — drawing must wait for the mount.
  useEffect(() => {
    if (enrolled !== false || locked || otpauthUri === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    QRCode.toCanvas(canvas, otpauthUri, { width: 180 }, (err) => {
      if (err) setError(err.message);
    });
  }, [enrolled, locked, otpauthUri]);

  const verify = async (): Promise<void> => {
    if (!/^\d{6}$/.test(code)) {
      setError('Enter a 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (enrolled === false) {
        // Enrollment path — capture recovery codes before navigating away.
        const resp = await api<EnrollConfirmResponse>('/auth/totp/enroll/confirm', {
          method: 'POST',
          body: JSON.stringify({ code }),
        });
        setRecoveryCodes(resp.recoveryCodes);
        await fetchWhoami(true);
        // Do NOT navigate yet — user must acknowledge recovery codes first.
        setSubmitting(false);
      } else {
        await api('/auth/totp/verify', {
          method: 'POST',
          body: JSON.stringify({ code }),
        });
        await fetchWhoami(true);
        nav('/admin', { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiCallError) {
        if (err.status === 423) {
          setLocked(true);
          setError('Too many attempts; locked for 15 minutes.');
        } else if (err.apiError.code === 'INVALID_CODE') {
          setError('Invalid code. Try again.');
        } else {
          setError(err.apiError.message);
        }
      } else {
        setError('Verification failed.');
      }
      setSubmitting(false);
    }
  };

  // Recovery codes panel — shown after successful enrollment until acknowledged.
  if (recoveryCodes.length > 0) {
    const codesText = recoveryCodes.join('\n');
    const handleCopyAll = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(codesText);
        setRecoveryCodesCopied(true);
      } catch {
        // Clipboard API unavailable — user must copy manually.
      }
    };
    const handleDownload = (): void => {
      const blob = new Blob([codesText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'assessiq-recovery-codes.txt';
      a.click();
      URL.revokeObjectURL(url);
    };
    return (
      <div
        className="aiq-screen"
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
      >
        <main
          style={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            padding: '48px 32px',
          }}
        >
          <Card padding="lg" style={{ width: '100%', maxWidth: 480 }}>
            <div style={{ marginBottom: 16 }}>
              <Chip variant="accent" leftIcon="sparkle">Recovery codes</Chip>
            </div>
            <h1
              className="aiq-serif"
              style={{ fontSize: 28, lineHeight: 1.15, margin: '0 0 10px', fontWeight: 400, letterSpacing: '-0.015em' }}
            >
              Save your recovery codes.
            </h1>
            <p style={{ fontSize: 14, color: 'var(--aiq-color-fg-secondary)', margin: '0 0 20px', lineHeight: 1.5 }}>
              These 10 codes are shown <strong>once only</strong>. If you lose access to your authenticator app,
              each code can be used once to sign in. Store them somewhere safe (password manager, printed paper).
            </p>

            {/* Code grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
                padding: 16,
                background: 'var(--aiq-color-bg-elevated)',
                border: '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-md)',
                marginBottom: 16,
              }}
            >
              {recoveryCodes.map((c) => (
                <code
                  key={c}
                  style={{
                    fontFamily: 'var(--aiq-font-mono)',
                    fontSize: 13,
                    letterSpacing: '0.06em',
                    color: 'var(--aiq-color-fg-primary)',
                    padding: '4px 0',
                  }}
                >
                  {c}
                </code>
              ))}
            </div>

            {/* Copy / download actions */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                onClick={() => void handleCopyAll()}
                style={{ flex: 1 }}
              >
                {recoveryCodesCopied ? 'Copied!' : 'Copy all'}
              </button>
              <button
                type="button"
                className="aiq-btn aiq-btn-ghost aiq-btn-sm"
                onClick={handleDownload}
                style={{ flex: 1 }}
              >
                Download .txt
              </button>
            </div>

            {/* Acknowledgement checkbox */}
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                cursor: 'pointer',
                marginBottom: 20,
                fontFamily: 'var(--aiq-font-sans)',
                fontSize: 14,
                color: 'var(--aiq-color-fg-primary)',
              }}
            >
              <input
                type="checkbox"
                checked={recoveryCodesSaved}
                onChange={(e) => setRecoveryCodesSaved(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              I've saved my recovery codes in a secure location.
            </label>

            <Button
              size="lg"
              onClick={() => nav('/admin', { replace: true })}
              disabled={!recoveryCodesSaved}
              style={{ width: '100%', justifyContent: 'center' }}
              rightIcon="arrow"
            >
              Continue to dashboard
            </Button>
          </Card>
        </main>
        <footer style={{ ...META_LABEL, padding: '16px 32px', display: 'flex', gap: 16, borderTop: '1px solid var(--aiq-color-border)' }}>
          <span>Phase 0 · 2026</span>
          <span style={{ flex: 1 }} />
          <span>Google SSO · TOTP-ready</span>
        </footer>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="aiq-screen"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', ...META_LABEL }}
      >
        Loading…
      </div>
    );
  }
  if (session === null) {
    return (
      <div className="aiq-screen" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 32 }}>
        No session.
      </div>
    );
  }

  // Title / body copy — three modes from screens/mfa.jsx
  const title = locked
    ? 'Verify your authenticator.'
    : enrolled === false
      ? 'Enrol your authenticator.'
      : 'Verify your authenticator.';
  const body = locked
    ? 'Too many failed attempts. Try again in 15 minutes.'
    : enrolled === false
      ? 'Scan the QR code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code below.'
      : 'Enter the 6-digit code from your authenticator app.';

  return (
    <div
      className="aiq-screen"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <main
        style={{
          flex: 1,
          display: 'grid',
          placeItems: 'center',
          padding: '48px 32px',
        }}
      >
        <Card
          padding="lg"
          style={{ width: '100%', maxWidth: 480 }}
          data-help-id="admin.auth.mfa.enroll_vs_verify"
        >
          <div style={{ marginBottom: 16 }}>
            <Chip variant="accent" leftIcon="sparkle">Step 2 of 2</Chip>
          </div>

          <h1
            className="aiq-serif"
            style={{
              fontSize: 32,
              lineHeight: 1.1,
              margin: '0 0 10px',
              fontWeight: 400,
              letterSpacing: '-0.015em',
            }}
          >
            {title}
          </h1>
          <p
            style={{
              fontSize: 14,
              color: 'var(--aiq-color-fg-secondary)',
              margin: '0 0 24px',
              lineHeight: 1.5,
            }}
          >
            {body}
          </p>

          {/* QR + manual-entry block — only on enrol */}
          {enrolled === false && !locked && (
            <div
              style={{
                display: 'grid',
                placeItems: 'center',
                marginBottom: 20,
                padding: 20,
                background: 'var(--aiq-color-bg-elevated)',
                border: '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-lg)',
              }}
            >
              <canvas ref={canvasRef} aria-label="TOTP enrolment QR code" />
              {secretBase32 !== null && (
                <>
                  <p
                    style={{
                      ...META_LABEL,
                      marginTop: 14,
                      letterSpacing: '0.06em',
                    }}
                  >
                    Or enter manually
                  </p>
                  <p
                    style={{
                      marginTop: 4,
                      fontFamily: 'var(--aiq-font-mono)',
                      fontSize: 13,
                      color: 'var(--aiq-color-fg-secondary)',
                      letterSpacing: '0.05em',
                      wordBreak: 'break-all',
                      textAlign: 'center',
                      maxWidth: 320,
                    }}
                  >
                    <strong>{secretBase32}</strong>
                  </p>
                </>
              )}
            </div>
          )}

          {/* 6-digit code input. Mono font, large character spacing
              (template idiom — letter-spacing 0.4em, centred). */}
          <label
            htmlFor="totp-code"
            style={{ ...META_LABEL, display: 'block', marginBottom: 6 }}
          >
            6-digit code
          </label>
          <input
            id="totp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={locked ? '' : code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              setError(null);
            }}
            disabled={locked || submitting}
            placeholder="••••••"
            style={{
              width: '100%',
              padding: '12px 16px',
              fontFamily: 'var(--aiq-font-mono)',
              fontSize: 22,
              letterSpacing: '0.4em',
              textAlign: 'center',
              color: 'var(--aiq-color-fg-primary)',
              background: 'var(--aiq-color-bg-base)',
              border: `1px solid ${error ? 'var(--aiq-color-danger, #b85450)' : 'var(--aiq-color-border-strong)'}`,
              borderRadius: 'var(--aiq-radius-md)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {error !== null && (
            <p
              style={{
                marginTop: 8,
                fontSize: 12,
                color: 'var(--aiq-color-danger, #b85450)',
              }}
            >
              {error}
            </p>
          )}

          {/* Primary verify button — full-width per template idiom */}
          <Button
            size="lg"
            onClick={verify}
            disabled={code.length !== 6 || submitting || locked}
            style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}
            rightIcon="arrow"
          >
            {locked
              ? 'Locked — try again later'
              : submitting
                ? 'Verifying…'
                : enrolled === false
                  ? 'Confirm and continue'
                  : 'Verify and continue'}
          </Button>

          {/* Secondary recovery-code link — only on verify mode (template).
              Hidden during enrol because no recovery codes exist yet. */}
          {enrolled !== false && (
            <p
              style={{
                marginTop: 18,
                fontSize: 13,
                color: 'var(--aiq-color-fg-secondary)',
                textAlign: 'center',
              }}
            >
              Lost your authenticator?{' '}
              <a
                href="#recovery"
                onClick={(e) => {
                  e.preventDefault();
                  // Recovery flow — Phase 1+ wires this to /api/auth/totp/recovery
                }}
                style={{
                  color: 'var(--aiq-color-accent)',
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                Use a recovery code
              </a>
            </p>
          )}
        </Card>
      </main>

      {/* Mono footer — template idiom (matches login.tsx). */}
      <footer
        style={{
          ...META_LABEL,
          padding: '16px 32px',
          display: 'flex',
          gap: 16,
          borderTop: '1px solid var(--aiq-color-border)',
        }}
      >
        <span>Phase 0 · 2026</span>
        <span style={{ flex: 1 }} />
        <span>Google SSO · TOTP-ready</span>
      </footer>
    </div>
  );
}
