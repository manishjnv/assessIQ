// Admin Login — single-pane centered layout — per user request 2026-05-14,
// the decorative right pane and mono footer from Phase 4 (commit e1caec1)
// were removed; only the form remains, centered on the viewport.
//
// Ported from modules/17-ui-system/AssessIQ_UI_Template/screens/login.jsx
// per the canonical-template rule in docs/10-branding-guideline.md § 0.
//
// Translation notes (intentional divergences from screens/login.jsx):
//
// 1. NO design-canvas signin/signup toggle — admin login is a single mode
//    (Google SSO). The kit's tab bar and "New here? Create an account" link
//    are designer-canvas affordances with no admin equivalent; removed.
//
// 2. NO email/password fields — admin authentication is Google-SSO-only
//    (see docs/04-auth-flows.md). The live pane shows Tenant Field +
//    "Continue with Google" only; the kit's email/password inputs and the
//    "or" divider are dropped.
//
// 3. NO secondary SSO button — the kit's "Single sign-on" outline button
//    appears next to Google SSO for the candidate-facing signup flow, which
//    doesn't apply here. Admin tenants always go through Google OAuth.
//
// 4. Kit token translation (--text → --aiq-color-fg-*, --surface → bg-raised,
//    --accent → --aiq-color-accent, --shadow-lg → --aiq-shadow-lg, etc.) per
//    docs/10-branding-guideline.md § 0 step 4.

import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Chip, Logo } from '@assessiq/ui-system';

// P1 — Tenant field removed. Identity resolution is now cross-tenant: Google
// verifies the email, then the backend resolves all eligible identities for
// that email across tenants. If there is exactly one match, the user is
// admitted immediately (same as before). If there are multiple matches, the
// user is redirected to /admin/select-identity to choose.
//
// Phase D — on mount, read the single-shot `aiq.lastAuthScope` sessionStorage
// key written by lib/session.ts when whoami responded 401 with details.scope.
// Render a state-aware banner so a user kicked out by a tenant suspend / user
// disable sees coherent copy instead of the generic "session expired" feel.

const SERIF_H1: CSSProperties = {
  fontSize: 44,
  lineHeight: 1.05,
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

interface AuthScopeBanner {
  title: string;
  body: string;
}

function readAuthScopeBanner(): AuthScopeBanner | null {
  try {
    const raw = sessionStorage.getItem('aiq.lastAuthScope');
    if (raw === null) return null;
    sessionStorage.removeItem('aiq.lastAuthScope'); // single-shot
    const parsed = JSON.parse(raw) as { scope?: unknown };
    const scope = typeof parsed.scope === 'string' ? parsed.scope : null;
    if (scope === 'tenant') {
      return {
        title: "Your organisation's access is paused.",
        body: 'An administrator has suspended or archived your company workspace. Please contact your administrator to restore access.',
      };
    }
    if (scope === 'user') {
      return {
        title: 'Your account has been disabled.',
        body: 'An administrator has disabled or removed your account. Please contact your administrator if you believe this is a mistake.',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function AdminLogin(): JSX.Element {
  const navigate = useNavigate();
  const [banner, setBanner] = useState<AuthScopeBanner | null>(null);

  useEffect(() => {
    setBanner(readAuthScopeBanner());
  }, []);

  const startGoogleSso = (): void => {
    window.location.href = '/api/auth/google/start';
  };

  const startEmailOtp = (): void => {
    navigate('/admin/login/email');
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

        {banner !== null && (
          <div
            role="status"
            style={{
              marginTop: 32,
              padding: '14px 16px',
              border: '1px solid var(--aiq-color-border)',
              borderLeft: '3px solid var(--aiq-color-warning, #d97706)',
              borderRadius: 'var(--aiq-radius-md)',
              background: 'var(--aiq-color-bg-sunken)',
              fontFamily: 'var(--aiq-font-sans)',
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--aiq-color-fg-primary)',
                marginBottom: 4,
              }}
            >
              {banner.title}
            </div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--aiq-color-fg-secondary)',
                lineHeight: 1.5,
              }}
            >
              {banner.body}
            </div>
          </div>
        )}

        <span style={{ display: 'inline-block', margin: '32px 0 24px' }}>
          <Chip variant="success">Welcome</Chip>
        </span>

        <h1 className="aiq-serif" style={SERIF_H1}>
          Sign in to continue.
        </h1>

        <p
          style={{
            color: 'var(--aiq-color-fg-secondary)',
            fontSize: 15,
            margin: '0 0 32px',
            lineHeight: 1.5,
            fontFamily: 'var(--aiq-font-sans)',
          }}
        >
          Pick up where you left off — your assessments are saved and waiting.
        </p>

        <Button
          size="lg"
          variant="outline"
          leftIcon="google"
          onClick={startGoogleSso}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Continue with Google
        </Button>

        {/* P2 — Email-OTP secondary action (admin/reviewer only).
            variant="outline" (not ghost) so it reads as a real button,
            consistent with the Google action above per the UI kit. */}
        <Button
          size="lg"
          variant="outline"
          onClick={startEmailOtp}
          style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
        >
          Email me a sign-in code
        </Button>
      </main>
    </div>
  );
}
