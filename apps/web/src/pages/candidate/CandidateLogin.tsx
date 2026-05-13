import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Field, Logo } from '@assessiq/ui-system';
import { api, ApiCallError } from '../../lib/api';

// Candidate magic-link login page.
//
// Anti-enumeration: regardless of whether the email matched a real user the
// same "we just sent you a sign-in link" confirmation is shown. The only
// exception is a 429 rate-limit response, which is safe to surface (it leaks
// nothing about account existence — only request frequency).
//
// ?error=invalid_link — set by CandidateLoginVerify when the verify endpoint
// does not 302 in time (stale / already-used magic link). We show a targeted
// message above the form.

export function CandidateLogin(): JSX.Element {
  const [params] = useSearchParams();
  const linkError = params.get('error') === 'invalid_link';

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'rate_limited'>('idle');

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
          {/* Stale / already-used magic link error — shown only when redirected
              here from CandidateLoginVerify with ?error=invalid_link. */}
          {linkError && status === 'idle' && (
            <div
              role="alert"
              style={{
                marginBottom: 24,
                padding: '12px 16px',
                borderRadius: 'var(--aiq-radius-sm)',
                background: 'var(--aiq-color-warn-soft, #fef9ec)',
                border: '1px solid var(--aiq-color-warn, oklch(0.72 0.15 70))',
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
              fontSize: 36,
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
                background: 'var(--aiq-color-warn-soft, #fef9ec)',
                border: '1px solid var(--aiq-color-warn, oklch(0.72 0.15 70))',
                color: 'var(--aiq-color-fg-primary)',
                fontFamily: 'var(--aiq-font-sans)',
                fontSize: 14,
              }}
            >
              Too many requests, try again in an hour.
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
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
                style={{ width: '100%', borderRadius: 9999 }}
              >
                Send me a sign-in link
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
