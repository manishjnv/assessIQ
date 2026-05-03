import { useState } from 'react';
import { Button, Chip, Field, Logo } from '@assessiq/ui-system';

const DEFAULT_TENANT_SLUG = 'wipro-soc';

export function AdminLogin(): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState(DEFAULT_TENANT_SLUG);

  const startGoogleSso = (): void => {
    const url = `/api/auth/google/start?tenant=${encodeURIComponent(tenantSlug)}`;
    window.location.href = url;
  };

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <main style={{ width: '100%', maxWidth: 420, padding: '48px 24px' }}>
        <Logo />
        <div style={{ marginTop: 48 }}>
          <span style={{ display: 'inline-block', marginBottom: 24 }}>
            <Chip variant="success">Welcome</Chip>
          </span>
          <h1
            className="aiq-serif"
            style={{
              fontSize: 44,
              lineHeight: 1.05,
              margin: '0 0 32px',
              fontWeight: 400,
              letterSpacing: '-0.025em',
            }}
          >
            Sign in to continue.
          </h1>

          <div
            style={{ marginBottom: 20 }}
            data-help-id="admin.auth.login.tenant_slug"
          >
            <Field
              label="Tenant"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              placeholder="wipro-soc"
            />
          </div>

          <Button
            size="lg"
            variant="outline"
            leftIcon="google"
            onClick={startGoogleSso}
            disabled={tenantSlug.length === 0}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Continue with Google
          </Button>
        </div>
      </main>
    </div>
  );
}