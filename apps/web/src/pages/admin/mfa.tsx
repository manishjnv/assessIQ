// Admin MFA — TOTP enrolment + verification.
//
// Ported from modules/17-ui-system/AccessIQ_UI_Template/screens/mfa.jsx
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
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);

  // Phase 0 doesn't expose a "have you enrolled?" endpoint — the heuristic
  // is: try /api/auth/totp/enroll/start; if it succeeds, we're enrolling
  // (returns the otpauth URI to render). If TOTP is already enrolled the
  // server returns 409 ALREADY_ENROLLED → skip QR, go to verify form.
  useEffect(() => {
    if (loading || session === null) return;
    if (session.mfaStatus === 'verified') {
      nav('/admin/users', { replace: true });
      return;
    }

    let cancelled = false;
    api<EnrollStartResponse>('/auth/totp/enroll/start', { method: 'POST' })
      .then((data) => {
        if (cancelled) return;
        setSecretBase32(data.secretBase32);
        setEnrolled(false);
        if (canvasRef.current) {
          QRCode.toCanvas(canvasRef.current, data.otpauthUri, { width: 180 }, (err) => {
            if (err) setError(err.message);
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ApiCallError) {
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

  const verify = async (): Promise<void> => {
    if (!/^\d{6}$/.test(code)) {
      setError('Enter a 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const path = enrolled === false
        ? '/auth/totp/enroll/confirm'
        : '/auth/totp/verify';
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      await fetchWhoami(true);
      nav('/admin/users', { replace: true });
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
