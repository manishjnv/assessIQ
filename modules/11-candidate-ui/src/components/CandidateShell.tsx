import React, { useEffect, useState } from 'react';
import { CandidateSessionBanner } from './CandidateSessionBanner.js';

// ---------------------------------------------------------------------------
// Local whoami hook — mirrors apps/web/src/lib/session.ts but lives here so
// @assessiq/candidate-ui has no runtime dependency on apps/web internals.
// Fetches GET /api/auth/whoami once per mount; re-fetches on sign-in.
// ---------------------------------------------------------------------------

interface WhoamiUser {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

interface WhoamiResult {
  user: WhoamiUser;
  expiresAt?: string;
}

function useWhoami(): { data: WhoamiResult | null; loading: boolean } {
  const [data, setData] = useState<WhoamiResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/whoami', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<WhoamiResult>) : null))
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CandidateShellProps {
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// CandidateShell
//
// Wraps candidate-facing pages with:
//   1. Sticky top bar — logo left, email + sign-out right
//   2. CandidateSessionBanner (amber, below top bar) — only ≤5 days remaining
//   3. Page content below
//
// Branding (docs/10-branding-guideline.md § 1, § 2, tokens.md):
//   - Top bar background: var(--aiq-color-bg-base) (#ffffff) with 1px bottom border
//   - Logo: aiq-mark component (text "AssessIQ")
//   - Sign-out text: var(--aiq-font-sans) 13px / 500, var(--aiq-color-fg-secondary)
//   - "Sign out" action: ghost link style (accent colour, no border)
//   - No shadows on top bar — "borders not shadows" per non-negotiables
// ---------------------------------------------------------------------------

const TOP_BAR_HEIGHT = 52;

export function CandidateShell({ children }: CandidateShellProps): React.ReactElement {
  const { data, loading } = useWhoami();

  const handleSignOut = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort; redirect regardless.
    }
    window.location.href = '/candidate/login';
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--aiq-color-bg-base)' }}>
      {/* Sticky top bar */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          height: TOP_BAR_HEIGHT,
          background: 'var(--aiq-color-bg-base)',
          borderBottom: '1px solid var(--aiq-color-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          gap: 16,
        }}
      >
        {/* Logo — left */}
        <div
          className="aiq-mark"
          role="img"
          aria-label="AssessIQ"
          style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', flex: 0 }}
        >
          <span className="aiq-mark-dot" aria-hidden="true" />
          <span>AssessIQ</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Session info + sign out — right */}
        {!loading && data !== null && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--aiq-font-sans)',
              fontSize: 13,
              color: 'var(--aiq-color-fg-secondary)',
            }}
          >
            <span>
              Signed in as{' '}
              <span
                style={{ fontWeight: 500, color: 'var(--aiq-color-fg-primary)' }}
              >
                {data.user.email ?? data.user.name ?? 'you'}
              </span>
            </span>
            <span aria-hidden="true" style={{ color: 'var(--aiq-color-border)' }}>·</span>
            <button
              onClick={handleSignOut}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                fontWeight: 500,
                color: 'var(--aiq-color-accent)',
                textDecoration: 'none',
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      {/* Session-expiry banner — only renders when ≤5 days left */}
      {!loading && data !== null && (
        <CandidateSessionBanner
          expiresAt={data.expiresAt}
          email={data.user.email}
          sessionId={data.user.id}
        />
      )}

      {/* Page content */}
      <main>{children}</main>
    </div>
  );
}
