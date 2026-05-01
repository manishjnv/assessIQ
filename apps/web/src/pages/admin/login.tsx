import type { CSSProperties } from 'react';
import { Button, Chip, Logo } from '@assessiq/ui-system';
import { saveSession } from '../../lib/session';
import { useNavigate } from 'react-router-dom';

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--aiq-color-fg-secondary)',
};

export function AdminLogin(): JSX.Element {
  const nav = useNavigate();

  const startGoogleSso = (): void => {
    // Real path (Window 4): window.location.href = '/api/auth/google/start';
    // FIXME(post-01-auth): swap dev mock for real Google SSO redirect once 01-auth ships.
    // Phase 0 dev mock: synthesize a bootstrap admin session and route to MFA.
    saveSession({
      tenantId: window.prompt('DEV: tenant id (uuid)') ?? '',
      userId: window.prompt('DEV: user id (uuid)') ?? '',
      role: 'admin',
      totpVerified: false,
    });
    nav('/admin/mfa');
  };

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)',
        gap: 0,
      }}
    >
      <main
        style={{
          padding: '64px 64px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          maxWidth: 720,
        }}
      >
        <Logo />
        <h1
          className="aiq-serif"
          style={{ fontSize: 56, lineHeight: 1.05, margin: '32px 0 16px' }}
        >
          Admin sign in.
        </h1>
        <p
          style={{
            fontSize: 18,
            lineHeight: 1.5,
            color: 'var(--aiq-color-fg-secondary)',
            maxWidth: 520,
            marginBottom: 40,
          }}
        >
          Continue with the Google account tied to your tenant.
          You will be asked to verify a one-time code from your authenticator app on the next step.
        </p>
        <div>
          <Button size="lg" leftIcon="google" onClick={startGoogleSso}>
            Continue with Google
          </Button>
        </div>
        <p style={{ ...META_LABEL, marginTop: 48 }}>
          Phase 0 dev build · 01-auth Window 4 swaps in real Google SSO
        </p>
      </main>

      <aside
        style={{
          background: 'var(--aiq-color-bg-elevated)',
          borderLeft: '1px solid var(--aiq-color-border)',
          padding: '64px 48px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <Chip variant="accent" leftIcon="sparkle">Phase 0</Chip>
          <p
            className="aiq-serif"
            style={{
              fontSize: 28,
              lineHeight: 1.3,
              marginTop: 24,
              color: 'var(--aiq-color-fg-primary)',
            }}
          >
            Role-readiness, scenario-driven, hybrid-graded.
          </p>
        </div>
        <div style={META_LABEL}>
          assessiq.automateedge.cloud
        </div>
      </aside>
    </div>
  );
}
