// Admin sign-in page. Ported from
// modules/17-ui-system/AccessIQ_UI_Template/screens/login.jsx per the
// canonical-template rule in docs/10-branding-guideline.md § 0.
//
// Translation notes (intentional divergences from screens/login.jsx,
// each anchored to the source-of-truth screen):
//
// 1. Auth shape — admin SSO ONLY, no email/password and no signup. The
//    template's email + password form, "or" divider, "Continue" primary
//    button, "Create an account" link, and second "SSO" button are all
//    OMITTED. The single "Continue with Google" outline button replaces
//    the entire auth section. Reason: per modules/01-auth/SKILL.md the
//    admin surface is Google-SSO-anchored (Phase 0); password auth is
//    Phase 3+. AssessIQ does not have a self-signup model.
//
// 2. Right-panel content — template shows candidate-marketing visuals
//    (mock 132/160 score card + AI-report floating card + Wired
//    blockquote). Admin login is NOT a marketing surface, so the
//    candidate visuals are REPLACED with admin-context content:
//    a Phase chip + a positioning tagline + a bottom URL meta line.
//    The template's STRUCTURAL idiom is preserved: surface background,
//    border-left, vertical-flex layout, bottom-anchored serif text.
//
// 3. Tenant input — template assumes a single login domain. Phase 0 ships
//    multi-tenant where the slug must be selected at start time. The
//    Field for tenant slug is admin-specific; it sits where the template
//    puts the email input. Phase 1+ will move tenant resolution to a
//    subdomain or tenant-picker per the SKILL.md open question.
//
// Everything else (two-column 1fr/1fr grid, Logo at top, big serif h1
// at 44px / fontWeight 400, mono uppercase footer with letter-spacing
// 0.08em) follows screens/login.jsx exactly.

import { useState, type CSSProperties } from 'react';
import { Button, Chip, Field, Logo } from '@assessiq/ui-system';

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
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
    // /api/auth/google/cb sets aiq_sess and 302's to /admin/users (when
    // MFA_REQUIRED=false) or /admin/mfa (when MFA_REQUIRED=true).
    const url = `/api/auth/google/start?tenant=${encodeURIComponent(tenantSlug)}`;
    window.location.href = url;
  };

  return (
    <div
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 0,
      }}
    >
      {/* Left — form. Mirrors template's left column: padding 48px 64px,
          flex-column with Logo at top, centered form middle, mono footer. */}
      <main
        style={{
          padding: '48px 64px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Logo />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <div style={{ width: '100%', maxWidth: 380 }}>
            {/* Status chip — template idiom. Success variant ships a check
                icon by default per Chip.tsx; matches the green-dot status
                pattern in screens/login.jsx. */}
            <span style={{ display: 'inline-block', marginBottom: 24 }}>
              <Chip variant="success">Welcome back</Chip>
            </span>
            <h1
              className="aiq-serif"
              style={{
                fontSize: 44,
                lineHeight: 1.05,
                margin: '0 0 12px',
                fontWeight: 400,
                letterSpacing: '-0.025em',
              }}
            >
              Sign in to continue.
            </h1>
            <p
              style={{
                color: 'var(--aiq-color-fg-secondary)',
                fontSize: 15,
                margin: '0 0 32px',
                lineHeight: 1.5,
              }}
            >
              Continue with the Google account tied to your tenant. You will be
              taken straight to the admin dashboard once authenticated.
            </p>

            {/* Tenant input — admin-specific divergence (see header note 3). */}
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

            {/* Outline button per template's "Continue with Google" pattern
                (screens/login.jsx:44). Matches the second auth option in
                the template, used here as the primary because admin auth
                is SSO-only. Width set via inline style — Button has no
                fullWidth prop; this matches the template's own technique. */}
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
        </div>

        {/* Mono footer — template idiom: version on left, compliance on right.
            Values reflect honest Phase 0 status. */}
        <div style={{ ...META_LABEL, display: 'flex', gap: 16 }}>
          <span>Phase 0 · 2026</span>
          <span style={{ flex: 1 }} />
          <span>Google SSO · TOTP-ready</span>
        </div>
      </main>

      {/* Right — admin-context visual panel. Preserves the template's
          structural idiom (surface bg, border-left, vertical flex, centered
          mid-content, bottom-anchored serif blockquote) but with admin-
          appropriate content (no candidate-marketing mock). */}
      <aside
        style={{
          background: 'var(--aiq-color-bg-elevated)',
          borderLeft: '1px solid var(--aiq-color-border)',
          padding: 48,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: 460, textAlign: 'left' }}>
            <Chip variant="accent" leftIcon="sparkle">Phase 0</Chip>
            <p
              className="aiq-serif"
              style={{
                fontSize: 28,
                lineHeight: 1.3,
                margin: '24px 0 0',
                color: 'var(--aiq-color-fg-primary)',
                letterSpacing: '-0.015em',
              }}
            >
              Role-readiness, scenario-driven, hybrid-graded.
            </p>
          </div>
        </div>

        {/* Bottom-anchored serif blockquote — template idiom. */}
        <blockquote
          className="aiq-serif"
          style={{
            fontSize: 22,
            lineHeight: 1.3,
            margin: 0,
            position: 'relative',
            maxWidth: 480,
            color: 'var(--aiq-color-fg-primary)',
            letterSpacing: '-0.015em',
          }}
        >
          “The first assessment platform that feels like reading.”
          <footer
            style={{
              marginTop: 12,
              fontFamily: 'var(--aiq-font-sans)',
              fontSize: 12,
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            assessiq.automateedge.cloud
          </footer>
        </blockquote>
      </aside>
    </div>
  );
}
