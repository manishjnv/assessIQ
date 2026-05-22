// Candidate magic-link login page.
//
// Ported from modules/17-ui-system/AssessIQ_UI_Template/screens/login.jsx
// (two-pane idiom) with candidate-side right pane mirroring
// apps/web/src/pages/take/TokenLanding.tsx.
//
// Translation notes (intentional divergences from screens/login.jsx):
//
// 1. NO signin/signup toggle — candidates have a single magic-link flow.
//    There is no signup action (accounts are provisioned by admins when
//    an assessment is assigned). The mode chip reflects the login state
//    only.
//
// 2. NO password field — the kit's login.jsx includes a password input
//    and a Google SSO button. Candidate auth is magic-link only. No
//    password, no OAuth, no "Continue with Google" button.
//
// 3. NO Google SSO or SSO buttons — see note 2. The divider + outline
//    social buttons from the kit are omitted entirely.
//
// 4. Right pane uses the calming-reassurance idiom (mirroring
//    TokenLanding.tsx RightPane) rather than the score-card marketing
//    mock from the kit. Admins see results-preview content; candidates
//    see calm reassurance before signing in.
//
// Anti-enumeration: regardless of whether the email matched a real user
// the same "we just sent you a sign-in link" confirmation is shown.
// The only exception is a 429 rate-limit response, which is safe to
// surface (it leaks nothing about account existence — only frequency).
//
// ?error=invalid_link — set by CandidateLoginVerify when the verify
// endpoint does not 302 in time (stale / already-used magic link).

import { type CSSProperties, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Chip, Field, Logo } from '@assessiq/ui-system';
import { api, ApiCallError } from '../../lib/api';
import { readAuthScopeOnce, authScopeCopy, type AuthScopeBannerCopy } from '../../lib/authScope';

// ─── shared style constants (mirrors TokenLanding.tsx) ───────────────────────

const META_LABEL: CSSProperties = {
  fontFamily: 'var(--aiq-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--aiq-color-fg-muted)',
};

// ─── right pane ──────────────────────────────────────────────────────────────

function RightPane(): JSX.Element {
  return (
    <aside
      style={{
        background: 'var(--aiq-color-bg-raised)',
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
          <Chip variant="success">Welcome</Chip>
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
            Your assessments are saved and waiting.
          </p>
        </div>
      </div>

      <blockquote
        className="aiq-serif"
        style={{
          fontSize: 22,
          lineHeight: 1.3,
          margin: 0,
          maxWidth: 480,
          color: 'var(--aiq-color-fg-primary)',
          letterSpacing: '-0.015em',
        }}
      >
        "Read carefully. The questions are scenario-driven; there are no trick
        options."
        <footer
          style={{
            marginTop: 12,
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 12,
            color: 'var(--aiq-color-fg-secondary)',
          }}
        >
          assessiq.in
        </footer>
      </blockquote>
    </aside>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function CandidateLogin(): JSX.Element {
  const [params] = useSearchParams();
  const linkError = params.get('error') === 'invalid_link';

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'rate_limited'>('idle');

  // Phase D — state-aware banner when a candidate's session was revoked by a
  // tenant suspend / user disable (RequireSession redirects here on the
  // 401-with-scope; lib/session.ts stashed the scope). Single-shot read on mount.
  const [authBanner, setAuthBanner] = useState<AuthScopeBannerCopy | null>(null);
  useEffect(() => {
    const scope = readAuthScopeOnce();
    setAuthBanner(scope === null ? null : authScopeCopy(scope, 'candidate'));
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (status === 'sending' || status === 'sent') return;
    setStatus('sending');
    try {
      // FIX 1: tenant_slug is now required by the API to scope the email lookup
      // under RLS (prevents cross-tenant email existence disclosure).
      // Hardcoded for now because only one production tenant is live.
      // TODO Phase 6: detect tenant from subdomain or URL ?tenant=… once
      // multi-tenant routing ships (e.g. wipro-soc.assessiq.com → 'wipro-soc').
      const tenant_slug = 'wipro-soc';
      await api('/auth/candidate/request-link', {
        method: 'POST',
        body: JSON.stringify({ email, tenant_slug }),
      });
      // Treat any 2xx as success — we never reveal whether the account existed.
      setStatus('sent');
    } catch (err) {
      if (err instanceof ApiCallError && err.status === 429) {
        setStatus('rate_limited');
      } else {
        // Any other error (5xx, network): still show the neutral "sent"
        // confirmation — anti-enumeration requires it. The candidate sees the
        // same message regardless of whether the backend errored.
        setStatus('sent');
      }
    }
  };

  return (
    <div
      className="aiq-screen aiq-candidate-login"
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 0,
      }}
    >
      <style>{`
        /* M1 mobile reflow — anchored to data-viewport (set by M0
           useViewportSync). Breakpoint is the M0 authoritative
           (max-width: 719px) OR (pointer:coarse AND max-width: 1024px),
           replacing the page-local 900px media query. */
        .aiq-candidate-login-main { padding: 48px 64px; }
        [data-viewport="mobile"] .aiq-candidate-login {
          grid-template-columns: 1fr;
        }
        [data-viewport="mobile"] .aiq-candidate-login > aside {
          display: none;
        }
        [data-viewport="mobile"] .aiq-candidate-login-main {
          padding: 24px 22px;
        }
      `}</style>
      {/* ── Left pane — form ──────────────────────────────────────────── */}
      <main
        className="aiq-candidate-login-main"
        style={{
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Logo />

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: 380 }}>
            {/* Phase D — session-revocation banner (tenant suspend / user
                disable). Shown once on mount when redirected here with a
                stashed scope; calmer candidate-facing copy. */}
            {authBanner !== null && (
              <div
                role="status"
                style={{
                  marginBottom: 24,
                  padding: '12px 16px',
                  borderRadius: 'var(--aiq-radius-sm)',
                  background: 'var(--aiq-color-warning-soft)',
                  border: '1px solid var(--aiq-color-warning)',
                  color: 'var(--aiq-color-fg-primary)',
                  fontFamily: 'var(--aiq-font-sans)',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  {authBanner.title}
                </div>
                <div
                  style={{ fontSize: 13, color: 'var(--aiq-color-fg-secondary)', lineHeight: 1.5 }}
                >
                  {authBanner.body}
                </div>
              </div>
            )}

            {/* Stale / already-used magic link error — shown only when
                redirected here from CandidateLoginVerify with
                ?error=invalid_link. */}
            {linkError && status === 'idle' && (
              <div
                role="alert"
                style={{
                  marginBottom: 24,
                  padding: '12px 16px',
                  borderRadius: 'var(--aiq-radius-sm)',
                  background: 'var(--aiq-color-warning-soft)',
                  border: '1px solid var(--aiq-color-warning)',
                  color: 'var(--aiq-color-fg-primary)',
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 14,
                }}
              >
                That link was expired or already used. Request a new one below.
              </div>
            )}

            <h1
              className="aiq-serif"
              style={{
                fontSize: 'var(--aiq-h1-size)',
                lineHeight: 1.1,
                margin: '0 0 8px',
                fontWeight: 500,
                letterSpacing: '-0.02em',
              }}
            >
              Sign in to your account.
            </h1>
            <p
              style={{
                margin: '0 0 32px',
                fontFamily: 'var(--aiq-font-sans)',
                fontSize: 14,
                color: 'var(--aiq-color-fg-secondary)',
              }}
            >
              We'll email you a secure sign-in link — no password needed.
            </p>

            {status === 'sent' ? (
              <div
                role="status"
                aria-live="polite"
                data-help-id="candidate.auth.link_sent"
                style={{
                  padding: '16px 20px',
                  borderRadius: 'var(--aiq-radius-sm)',
                  background: 'var(--aiq-color-accent-soft)',
                  border: '1px solid var(--aiq-color-accent)',
                  color: 'var(--aiq-color-fg-primary)',
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                If an account exists with that email, we just sent you a sign-in
                link. Check your inbox; the link expires in 15 minutes.
              </div>
            ) : status === 'rate_limited' ? (
              <div
                role="alert"
                style={{
                  padding: '16px 20px',
                  borderRadius: 'var(--aiq-radius-sm)',
                  background: 'var(--aiq-color-warning-soft)',
                  border: '1px solid var(--aiq-color-warning)',
                  color: 'var(--aiq-color-fg-primary)',
                  fontFamily: 'var(--aiq-font-sans)',
                  fontSize: 14,
                }}
              >
                Too many requests, try again in an hour.
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate data-help-id="candidate.auth.request_link">
                <Field
                  label="Email address"
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ marginBottom: 24 }}
                />
                <Button
                  type="submit"
                  variant="primary"
                  loading={status === 'sending'}
                  disabled={!email.trim()}
                  style={{ width: '100%' }}
                >
                  Send me a sign-in link
                </Button>
              </form>
            )}
          </div>
        </div>
      </main>

      {/* ── Right pane — candidate-side calming idiom ─────────────────── */}
      {/* Hidden below ~900 px via the scoped style block below.           */}
      <RightPane />
    </div>
  );
}
