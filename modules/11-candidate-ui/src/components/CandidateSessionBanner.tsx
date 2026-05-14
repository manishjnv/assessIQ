import React, { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CandidateSessionBannerProps {
  /** ISO 8601 UTC expiry from the session — from /api/auth/whoami expiresAt. */
  expiresAt: string | undefined;
  /** Current session's user email — used to POST a renewal request-link. */
  email: string | null;
  /** Session id — used to key localStorage dismissal so it is per-session. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOW_THRESHOLD_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dismissKey(sessionId: string): string {
  return `aiq-session-banner-dismissed:${sessionId}`;
}

// ---------------------------------------------------------------------------
// CandidateSessionBanner
//
// Fixed-position amber banner shown when the candidate's session has ≤ 5 days
// remaining. Dismissible per-session (localStorage keyed by session id).
//
// Branding decisions (docs/10-branding-guideline.md):
//   - Background: amber `oklch(0.97 0.05 70)` — lightest tint of --warn;
//     no direct --aiq-color-warn-soft token exists in the token set so we
//     inline the value; it is within the "accent rules" single-hue constraint
//     because --warn is a status colour.
//   - Border: 1px `oklch(0.72 0.15 70)` (--warn), not a shadow.
//   - Body copy: var(--aiq-font-sans) 13px / 500 — label weight.
//   - "Send me a new link" button: aiq-btn-ghost size sm, stays in-line.
// ---------------------------------------------------------------------------

export function CandidateSessionBanner({
  expiresAt,
  email,
  sessionId,
}: CandidateSessionBannerProps): React.ReactElement | null {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(dismissKey(sessionId)) === '1';
    } catch {
      return false;
    }
  });
  const [renewStatus, setRenewStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  // Re-check dismissal when sessionId changes (e.g. page navigation between
  // sessions, though unlikely in practice).
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissKey(sessionId)) === '1');
    } catch {
      // localStorage may be unavailable in restricted contexts; fail open.
    }
  }, [sessionId]);

  if (!expiresAt) return null;

  const daysLeft = (new Date(expiresAt).getTime() - Date.now()) / MS_PER_DAY;

  // Only render when 0 < daysLeft ≤ 5.
  if (daysLeft > SHOW_THRESHOLD_DAYS || daysLeft < 0) return null;
  if (dismissed) return null;

  const daysDisplay = Math.ceil(daysLeft);

  const handleDismiss = (): void => {
    try {
      localStorage.setItem(dismissKey(sessionId), '1');
    } catch {
      // ignore
    }
    setDismissed(true);
  };

  const handleRenew = async (): Promise<void> => {
    if (!email || renewStatus !== 'idle') return;
    setRenewStatus('sending');
    try {
      await fetch('/api/auth/candidate/request-link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Swallow — same anti-enumeration discipline; the user sees "sent"
      // either way because we don't reveal success/failure.
    } finally {
      setRenewStatus('sent');
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-help-id="candidate.auth.expiring-soon"
      style={{
        background: 'oklch(0.97 0.05 70)',
        borderBottom: '1px solid oklch(0.72 0.15 70)',
        padding: '8px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'var(--aiq-font-sans)',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--aiq-color-fg-primary)',
      }}
    >
      <span style={{ flex: 1 }}>
        {renewStatus === 'sent' ? (
          'A new sign-in link is on its way — check your inbox.'
        ) : (
          <>
            Your sign-in expires in {daysDisplay} day{daysDisplay !== 1 ? 's' : ''}.{' '}
            <button
              onClick={handleRenew}
              disabled={renewStatus === 'sending' || !email}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: renewStatus === 'sending' ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                fontWeight: 600,
                color: 'var(--aiq-color-accent)',
                textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
            >
              {renewStatus === 'sending' ? 'Sending…' : 'Send me a new link'}
            </button>
          </>
        )}
      </span>
      <button
        aria-label="Dismiss session expiry warning"
        onClick={handleDismiss}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          color: 'var(--aiq-color-fg-muted)',
          fontSize: 16,
          lineHeight: 1,
          fontFamily: 'inherit',
        }}
      >
        ×
      </button>
    </div>
  );
}
