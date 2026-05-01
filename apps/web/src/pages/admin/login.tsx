import { useState, type CSSProperties } from 'react';
import { Button, Chip, Field, Logo } from '@assessiq/ui-system';

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--aiq-color-fg-secondary)',
};

// Default tenant slug for Phase 0 (single-tenant bootstrap). The slug is
// validated server-side; an unknown slug returns 401. Future phases will
// support per-tenant subdomain or a tenant picker.
const DEFAULT_TENANT_SLUG = 'wipro-soc';

export function AdminLogin(): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState(DEFAULT_TENANT_SLUG);

  const startGoogleSso = (): void => {
    // Server-side OIDC: /api/auth/google/start?tenant=<slug> sets state +
    // nonce cookies and 302's to accounts.google.com. The callback at
    // /api/auth/google/cb sets aiq_sess and 302's to /admin/mfa.
    const url = `/api/auth/google/start?tenant=${encodeURIComponent(tenantSlug)}`;
    window.location.href = url;
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
        <div style={{ marginBottom: 24, maxWidth: 320 }}>
          <Field
            label="Tenant"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            placeholder="wipro-soc"
          />
        </div>
        <div>
          <Button size="lg" leftIcon="google" onClick={startGoogleSso} disabled={tenantSlug.length === 0}>
            Continue with Google
          </Button>
        </div>
        <p style={{ ...META_LABEL, marginTop: 48 }}>
          Phase 0 closure · Google SSO + TOTP · live end-to-end
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
