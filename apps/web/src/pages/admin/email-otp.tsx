// apps/web/src/pages/admin/email-otp.tsx
//
// P2 — Admin email-OTP login flow.
//
// Two-step single-page flow (no RequireSession — pre-session):
//   Step 1: Email input → POST /api/auth/login/email/request
//           Always shows "If that email can sign in, we've sent a 6-digit code"
//           (anti-enumeration — same message regardless of eligibility).
//   Step 2: 6-digit code input → POST /api/auth/login/email/verify
//           A correct 6th digit signs in at once (no extra click).
//           On ok:true  → window.location.href = redirectTo (hard nav, same as select-identity).
//           On ok:false → show "That code is not right. Check it and try again."
//                         (server enforces ≤5 attempts + 10-min TTL lockout).
//
// No new ui-system primitives — reuses Button, Chip, Logo from @assessiq/ui-system,
// same layout idiom as login.tsx and select-identity.tsx.

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Chip, Logo, Field } from '@assessiq/ui-system';
import { api, ApiCallError } from '../../lib/api.js';

const SERIF_H1: CSSProperties = {
  fontSize: 44,
  lineHeight: 1.05,
  margin: '0 0 12px',
  fontWeight: 400,
  letterSpacing: '-0.025em',
};

type Step = 'email' | 'code';

const WRONG_CODE_MSG = 'That code is not right. Check it and try again.';

export function AdminEmailOtp(): React.JSX.Element {
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
      await api('/auth/login/email/request', {
        method: 'POST',
        cache: 'no-store',
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

  async function verifyCode(value: string): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setCodeError(null);

    try {
      const data = await api<{ ok: boolean; redirectTo?: string; error?: string }>(
        '/auth/login/email/verify',
        { method: 'POST', cache: 'no-store', body: JSON.stringify({ email, code: value }) },
      );

      if (data.ok && typeof data.redirectTo === 'string') {
        // Hard navigation — same pattern as select-identity.tsx's handleSelect.
        // Ensures the session cookie set by the API is picked up cleanly.
        window.location.href = data.redirectTo;
        return;
      }

      // ok:false → one generic message (server enforces lockout after ≤5 attempts;
      // wrong, expired and locked are never told apart — anti-enumeration).
      setCodeError(WRONG_CODE_MSG);
    } catch (err) {
      // A non-2xx reply (ok:false, lockout) is the same generic invalid-code message.
      setCodeError(
        err instanceof ApiCallError ? WRONG_CODE_MSG : 'Something went wrong. Please try again.',
      );
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
          {step === 'email' ? 'Enter your email.' : 'Enter your sign-in code.'}
        </h1>

        {step === 'email' ? (
          <>
            <p
              style={{
                color: 'var(--aiq-color-fg-secondary)',
                fontSize: 'var(--aiq-text-lg)',
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
                {submitting ? 'Sending…' : 'Send sign-in code'}
              </Button>
            </form>
          </>
        ) : (
          <>
            <p
              style={{
                color: 'var(--aiq-color-fg-secondary)',
                fontSize: 'var(--aiq-text-lg)',
                margin: '0 0 8px',
                lineHeight: 1.5,
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              If that email can sign in, we've sent a 6-digit sign-in code. Enter it below.
            </p>
            <p
              style={{
                color: 'var(--aiq-color-fg-muted)',
                fontSize: 13,
                margin: '0 0 24px',
                fontFamily: 'var(--aiq-font-sans)',
              }}
            >
              The sign-in code expires in 10 minutes. You have up to 5 attempts.
            </p>

            <form onSubmit={(e) => { e.preventDefault(); void verifyCode(code); }}>
              <div style={{ marginBottom: 16 }}>
                <Field
                  label="6-digit sign-in code"
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
                    // Sign in as soon as the 6th digit is typed: no extra click.
                    if (val.length === 6) void verifyCode(val);
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
              <p style={{ marginTop: 12, textAlign: 'center', fontSize: 14 }}>
                <button
                  type="button"
                  onClick={() => { setStep('email'); setCode(''); setCodeError(null); }}
                  style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--aiq-color-accent)', fontSize: 14 }}
                >
                  Send a new code
                </button>
              </p>
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
