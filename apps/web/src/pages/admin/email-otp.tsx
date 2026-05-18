// apps/web/src/pages/admin/email-otp.tsx
//
// P2 — Admin email-OTP login flow.
//
// Two-step single-page flow (no RequireSession — pre-session):
//   Step 1: Email input → POST /api/auth/login/email/request
//           Always shows "If that email can sign in, we've sent a 6-digit code"
//           (anti-enumeration — same message regardless of eligibility).
//   Step 2: 6-digit code input → POST /api/auth/login/email/verify
//           On ok:true  → window.location.href = redirectTo (hard nav, same as select-identity).
//           On ok:false → show generic "Invalid or expired code. Try again."
//                         (server enforces ≤5 attempts + 10-min TTL lockout).
//
// No new ui-system primitives — reuses Button, Chip, Logo from @assessiq/ui-system,
// same layout idiom as login.tsx and select-identity.tsx.

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Chip, Logo, Field } from '@assessiq/ui-system';

const SERIF_H1: CSSProperties = {
  fontSize: 44,
  lineHeight: 1.05,
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

type Step = 'email' | 'code';

export function AdminEmailOtp(): JSX.Element {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  async function handleEmailSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    try {
      // Fire-and-forget from the UI perspective — anti-enumeration: we always
      // advance to step 2 regardless of the server's action.
      await fetch('/api/auth/login/email/request', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Network error: still advance to step 2 — anti-enumeration.
    } finally {
      setSubmitting(false);
    }

    // Always advance to code step — never reveal whether the email is eligible.
    setStep('code');
  }

  async function handleCodeSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setCodeError(null);

    try {
      const res = await fetch('/api/auth/login/email/verify', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });

      const data = (await res.json()) as { ok: boolean; redirectTo?: string; error?: string };

      if (data.ok && typeof data.redirectTo === 'string') {
        // Hard navigation — same pattern as select-identity.tsx's handleSelect.
        // Ensures the session cookie set by the API is picked up cleanly.
        window.location.href = data.redirectTo;
        return;
      }

      // ok:false → generic error (server enforces lockout after ≤5 attempts).
      setCodeError('Invalid or expired code. Please try again.');
    } catch {
      setCodeError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

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

        <span style={{ display: 'inline-block', margin: '32px 0 24px' }}>
          <Chip variant="accent">Sign in with email</Chip>
        </span>

        <h1 className="aiq-serif" style={SERIF_H1}>
          {step === 'email' ? 'Enter your email.' : 'Enter your code.'}
        </h1>

        {step === 'email' ? (
          <>
            <p
              style={{
                color: 'var(--aiq-color-fg-secondary)',
                fontSize: 15,
                margin: '0 0 32px',
                lineHeight: 1.5,
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              We'll send a 6-digit sign-in code to your email address.
            </p>

            <form onSubmit={(e) => { void handleEmailSubmit(e); }}>
              <div style={{ marginBottom: 16 }}>
                <Field
                  label="Email address"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  disabled={submitting}
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <Button
                size="lg"
                variant="outline"
                type="submit"
                disabled={submitting || email.trim().length === 0}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {submitting ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          </>
        ) : (
          <>
            <p
              style={{
                color: 'var(--aiq-color-fg-secondary)',
                fontSize: 15,
                margin: '0 0 8px',
                lineHeight: 1.5,
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              If that email can sign in, we've sent a 6-digit code. Enter it below.
            </p>
            <p
              style={{
                color: 'var(--aiq-color-fg-muted)',
                fontSize: 13,
                margin: '0 0 24px',
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              Code expires in 10 minutes. You have up to 5 attempts.
            </p>

            <form onSubmit={(e) => { void handleCodeSubmit(e); }}>
              <div style={{ marginBottom: 16 }}>
                <Field
                  label="6-digit code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    // Allow only digits.
                    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setCode(val);
                    if (codeError !== null) setCodeError(null);
                  }}
                  placeholder="000000"
                  required
                  disabled={submitting}
                  autoComplete="one-time-code"
                  autoFocus
                  {...(codeError !== null ? { error: codeError } : {})}
                  style={{
                    fontSize: 24,
                    letterSpacing: '0.25em',
                    fontFamily: 'var(--aiq-font-mono)',
                    textAlign: 'center',
                  }}
                />
              </div>

              <Button
                size="lg"
                variant="outline"
                type="submit"
                disabled={submitting || code.length !== 6}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {submitting ? 'Verifying…' : 'Verify'}
              </Button>
            </form>
          </>
        )}

        {/* Use Google instead link — always visible */}
        <p
          style={{
            marginTop: 24,
            textAlign: 'center',
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 14,
            color: 'var(--aiq-color-fg-muted)',
          }}
        >
          Or{' '}
          <Link
            to="/admin/login"
            style={{
              color: 'var(--aiq-color-accent)',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            sign in with Google instead
          </Link>
        </p>
      </main>
    </div>
  );
}
