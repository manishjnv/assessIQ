import { useEffect, useRef, useState } from 'react';
import { Button, Card, Field, Chip } from '@assessiq/ui-system';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useSession, saveSession } from '../../lib/session';

export function AdminMfa(): JSX.Element {
  const session = useSession();
  const nav = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    // FIXME(post-01-auth): replace with /api/auth/totp/enroll/start which returns
    // the otpauth URI generated server-side from a fresh 20-byte SHA-1 secret.
    // Phase 0 mock: synthesize a placeholder URI just to render the QR.
    const otpauth = `otpauth://totp/AssessIQ:dev-${session.userId.slice(0, 8)}?secret=JBSWY3DPEHPK3PXP&issuer=AssessIQ&period=30&digits=6&algorithm=SHA1`;
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, otpauth, { width: 240 }, (err) => {
        if (err) setError(err.message);
      });
    }
  }, [session]);

  const verify = (): void => {
    if (!session) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter a 6-digit code from your authenticator app.');
      return;
    }
    // FIXME(post-01-auth): POST /api/auth/totp/verify with the entered code.
    // Phase 0 mock: any well-formed 6-digit code passes; promote the session.
    saveSession({ ...session, totpVerified: true });
    nav('/admin/users');
  };

  if (!session) {
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
          Verify your authenticator.
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--aiq-color-fg-secondary)',
            marginBottom: 24,
          }}
        >
          Scan the QR code with Google Authenticator, Authy, or 1Password, then enter
          the 6-digit code below.
        </p>
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
        </div>
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
          <Button size="lg" onClick={verify} disabled={code.length !== 6}>
            Verify and continue
          </Button>
        </div>
      </Card>
    </div>
  );
}
