// Admin Login — two-pane split-hero layout.
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
//    (see docs/04-auth-flows.md). The live left pane shows Tenant Field +
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

import { useState, type CSSProperties } from 'react';
import { Button, Chip, Field, Icon, Logo } from '@assessiq/ui-system';

const DEFAULT_TENANT_SLUG = 'wipro-soc';

// ─── shared style constants (mirrors TokenLanding.tsx idiom) ─────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

const SERIF_H1: CSSProperties = {
  fontSize: 44,
  lineHeight: 1.05,
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

// ─── mini bar chart data ──────────────────────────────────────────────────────

const BAR_VALUES = [78, 92, 65, 88, 71] as const;
const BAR_LABELS = ['Vrbl', 'Lgcl', 'Sptl', 'Nmrl', 'Mem'] as const;

// ─── right pane — decorative score-card preview ───────────────────────────────

function RightPane(): JSX.Element {
  return (
    <aside
      aria-hidden="true"
      style={{
        background: 'var(--aiq-color-bg-raised)',
        borderLeft: '1px solid var(--aiq-color-border)',
        position: 'relative',
        overflow: 'hidden',
        padding: 48,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Grid background — login visual panel only (branding-guideline § 8.8) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.5,
          backgroundImage:
            'linear-gradient(var(--aiq-color-border) 1px, transparent 1px), ' +
            'linear-gradient(90deg, var(--aiq-color-border) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage:
            'radial-gradient(circle at 60% 40%, black, transparent 70%)',
          WebkitMaskImage:
            'radial-gradient(circle at 60% 40%, black, transparent 70%)',
        }}
      />

      {/* Centered card area */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: '100%', maxWidth: 460 }}>
          {/* Primary score card */}
          <div
            aria-hidden="true"
            style={{
              padding: 28,
              background: 'var(--aiq-color-bg-base)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-lg)',
              boxShadow: 'var(--aiq-shadow-lg)',
            }}
          >
            {/* Header row */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
              }}
            >
              <span
                style={{
                  ...META_LABEL,
                  textTransform: 'uppercase',
                }}
              >
                Cognitive · Final score
              </span>
              <Chip variant="success">Passed</Chip>
            </div>

            {/* Score row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                marginBottom: 24,
              }}
            >
              {/* aiq-num = serif lining-tabular-nums (branding-guideline § 2.2) */}
              <span
                className="aiq-num"
                style={{
                  fontSize: 88,
                  fontWeight: 500,
                  lineHeight: 1,
                  letterSpacing: '-0.04em',
                }}
              >
                132
              </span>
              <span
                style={{
                  color: 'var(--aiq-color-fg-secondary)',
                  fontSize: 14,
                  fontFamily: 'var(--aiq-font-sans)',
                }}
              >
                / 160
              </span>
              <span style={{ flex: 1 }} />
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...META_LABEL, textTransform: 'uppercase' }}>
                  Percentile
                </div>
                <span className="aiq-num" style={{ fontSize: 22 }}>
                  97
                  <span
                    style={{
                      fontSize: 14,
                      color: 'var(--aiq-color-fg-secondary)',
                      fontFamily: 'var(--aiq-font-sans)',
                    }}
                  >
                    th
                  </span>
                </span>
              </div>
            </div>

            {/* Mini bar chart — 5-column divs, no charting library */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 1fr)',
                gap: 8,
                marginBottom: 16,
              }}
            >
              {BAR_VALUES.map((v, i) => (
                <div key={BAR_LABELS[i]}>
                  <div
                    style={{ height: 60, display: 'flex', alignItems: 'flex-end' }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: `${v}%`,
                        background:
                          i === 1
                            ? 'var(--aiq-color-accent)'
                            : 'var(--aiq-color-bg-sunken)',
                        borderRadius: 4,
                        transition: 'all 0.3s',
                      }}
                    />
                  </div>
                  <div
                    style={{
                      ...META_LABEL,
                      textAlign: 'center',
                      marginTop: 6,
                      fontSize: 9,
                    }}
                  >
                    {BAR_LABELS[i]}
                  </div>
                </div>
              ))}
            </div>

            {/* Divider */}
            <div
              style={{
                height: 1,
                background: 'var(--aiq-color-border)',
                margin: '16px 0',
              }}
            />

            {/* Footer meta row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--aiq-color-fg-secondary)',
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              <Icon name="clock" size={12} aria-hidden />
              <span>Completed in 47:12</span>
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: 'var(--aiq-font-mono)',
                  fontSize: 11,
                  color: 'var(--aiq-color-fg-muted)',
                }}
              >
                #A-2841
              </span>
            </div>
          </div>

          {/* Floating "AI report ready" callout card */}
          <div
            aria-hidden="true"
            style={{
              padding: 16,
              background: 'var(--aiq-color-bg-base)',
              border: '1px solid var(--aiq-color-border)',
              borderRadius: 'var(--aiq-radius-lg)',
              boxShadow: 'var(--aiq-shadow-lg)',
              marginTop: -24,
              marginLeft: 60,
              marginRight: -40,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'var(--aiq-color-accent-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--aiq-color-accent)',
                flexShrink: 0,
              }}
            >
              <Icon name="sparkle" size={16} aria-hidden />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'var(--aiq-font-sans)',
                  color: 'var(--aiq-color-fg-primary)',
                }}
              >
                Your AI report is ready
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--aiq-color-fg-secondary)',
                  fontFamily: 'var(--aiq-font-sans)',
                }}
              >
                3 strengths · 2 growth areas
              </div>
            </div>
            <Icon name="arrow" size={14} aria-hidden />
          </div>
        </div>
      </div>

      {/* Serif blockquote — kit line 136-141, "AccessIQ 2.0" → "AssessIQ" */}
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
        "It's the first assessment platform that feels like reading."
        <footer
          style={{
            marginTop: 12,
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 12,
            color: 'var(--aiq-color-fg-secondary)',
          }}
        >
          — Wired, on AssessIQ
        </footer>
      </blockquote>
    </aside>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function AdminLogin(): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState(DEFAULT_TENANT_SLUG);

  const startGoogleSso = (): void => {
    const url = `/api/auth/google/start?tenant=${encodeURIComponent(tenantSlug)}`;
    window.location.href = url;
  };

  return (
    <>
      {/* Responsive: collapse right pane below 900px */}
      <style>{`
        @media (max-width: 900px) {
          .aiq-login-right { display: none !important; }
          .aiq-login-grid  { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div
        className="aiq-screen aiq-login-grid"
        style={{
          minHeight: '100vh',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
        }}
      >
        {/* Left pane — form */}
        <main
          style={{
            padding: '48px 64px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Logo />

          {/* Centered form area */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <div style={{ width: '100%', maxWidth: 380 }}>
              <span style={{ display: 'inline-block', marginBottom: 24 }}>
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
                Pick up where you left off — your assessments are saved and
                waiting.
              </p>

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
          </div>

          {/* Mono footer — matches TokenLanding.tsx META_LABEL idiom */}
          <div style={{ ...META_LABEL, display: 'flex', gap: 16 }}>
            <span>Phase 0 · 2026</span>
            <span style={{ flex: 1 }} />
            <span>Google SSO · TOTP-ready</span>
          </div>
        </main>

        {/* Right pane — decorative score-card preview */}
        <div className="aiq-login-right">
          <RightPane />
        </div>
      </div>
    </>
  );
}
