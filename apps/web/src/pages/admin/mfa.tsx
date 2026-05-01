import { useEffect, useRef, useState } from 'react';
import { Button, Card, Field, Chip } from '@assessiq/ui-system';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, ApiCallError } from '../../lib/api';
import { fetchWhoami, useSession } from '../../lib/session';

interface EnrollStartResponse {
  otpauthUri: string;
  secretBase32: string;
}

export function AdminMfa(): JSX.Element {
  const { session, loading } = useSession();
  const nav = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [secretBase32, setSecretBase32] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Phase 0 doesn't expose a "have you enrolled?" endpoint — the heuristic
  // is: try /api/auth/totp/enroll/start; if it succeeds, we're enrolling
  // (returns the otpauth URI to render). If TOTP is already enrolled the
  // library re-stages a fresh secret + URI (idempotent), so the UX is just
  // "show QR every visit while pre-MFA." Future hardening will surface a
  // /whoami flag for "totp_enrolled".
  useEffect(() => {
    if (loading || session === null) return;
    if (session.mfaStatus === 'verified') {
      // Already verified — bounce to /admin/users.
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
          QRCode.toCanvas(canvasRef.current, data.otpauthUri, { width: 240 }, (err) => {
            if (err) setError(err.message);
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ApiCallError) {
          // If the server says we're already enrolled (409 ALREADY_ENROLLED),
          // skip the QR and go straight to the verify form.
          if (err.status === 409 || err.apiError.code === 'ALREADY_ENROLLED') {
            setEnrolled(true);
          } else {
            setError(err.apiError.message);
          }
        } else {
          setError('Could not start TOTP enrollment.');
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
      // If we showed the QR (enrolling), call confirm; otherwise verify.
      const path = enrolled === false
        ? '/auth/totp/enroll/confirm'
        : '/auth/totp/verify';
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      // Refresh whoami so RequireSession sees mfaStatus='verified'.
      await fetchWhoami(true);
      nav('/admin/users', { replace: true });
    } catch (err) {
      if (err instanceof ApiCallError) {
        if (err.status === 423) {
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
        style={{ padding: 32, fontFamily: 'var(--aiq-font-mono)', fontSize: 12 }}
      >
        Loading…
      </div>
    );
  }
  if (session === null) {
    return <div className="aiq-screen" style={{ padding: 32 }}>No session.</div>;
  }

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        padding: '64px 32px',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Card padding="lg" style={{ width: '100%', maxWidth: 480 }}>
        <Chip variant="accent">Step 2 of 2</Chip>
        <h1 className="aiq-serif" style={{ fontSize: 32, margin: '16px 0 8px' }}>
          {enrolled === false ? 'Enroll your authenticator.' : 'Verify your authenticator.'}
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--aiq-color-fg-secondary)',
            marginBottom: 24,
          }}
        >
          {enrolled === false
            ? 'Scan the QR code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code below.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
        {enrolled === false && (
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              marginBottom: 24,
              padding: 16,
              background: 'var(--aiq-color-bg-elevated)',
              borderRadius: 12,
            }}
          >
            <canvas ref={canvasRef} aria-label="TOTP enrollment QR code" />
            {secretBase32 !== null && (
              <p
                style={{
                  marginTop: 12,
                  fontFamily: 'var(--aiq-font-mono)',
                  fontSize: 11,
                  color: 'var(--aiq-color-fg-muted)',
                }}
              >
                Or enter manually: <strong>{secretBase32}</strong>
              </p>
            )}
          </div>
        )}
        <Field
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          {...(error ? { error } : {})}
        />
        <div style={{ marginTop: 24 }}>
          <Button size="lg" onClick={verify} disabled={code.length !== 6 || submitting}>
            {submitting ? 'Verifying…' : 'Verify and continue'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
