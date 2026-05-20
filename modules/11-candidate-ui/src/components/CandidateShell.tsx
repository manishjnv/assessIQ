import React, { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon } from '@assessiq/ui-system';
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

// M4 — shared NavLink style. Active route gets a soft raised background +
// primary fg color; inactive stays secondary. Applies in both the desktop
// inline nav and the mobile overflow menu.
const NAV_LINK_BASE: React.CSSProperties = {
  fontFamily: 'var(--aiq-font-sans)',
  fontSize: 13,
  fontWeight: 500,
  textDecoration: 'none',
  padding: '6px 10px',
  borderRadius: 'var(--aiq-radius-sm)',
  display: 'inline-block',
};

function navLinkStyle({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    ...NAV_LINK_BASE,
    color: isActive ? 'var(--aiq-color-fg-primary)' : 'var(--aiq-color-fg-secondary)',
    background: isActive ? 'var(--aiq-color-bg-raised)' : 'transparent',
  };
}

function menuItemStyle({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    ...NAV_LINK_BASE,
    width: '100%',
    color: isActive ? 'var(--aiq-color-fg-primary)' : 'var(--aiq-color-fg-secondary)',
    background: isActive ? 'var(--aiq-color-bg-raised)' : 'transparent',
  };
}

export function CandidateShell({ children }: CandidateShellProps): React.ReactElement {
  const { data, loading } = useWhoami();
  // M4 — mobile overflow-menu open state. Desktop never opens it (the
  // .aiq-candidate-nav-mobile container is display:none on desktop); closes
  // on outside-click, Escape, or item-select.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleSignOut = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort; redirect regardless.
    }
    window.location.href = '/candidate/login';
  };

  // M4 — outside-click + Escape close the mobile overflow menu. Effect is a
  // no-op when menuOpen=false (no listeners attached), so desktop pays nothing.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="aiq-candidate-shell" style={{ minHeight: '100vh', background: 'var(--aiq-color-bg-base)' }}>
      {/* Sticky top bar */}
      <header
        className="aiq-candidate-shell-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          height: TOP_BAR_HEIGHT,
          background: 'var(--aiq-color-bg-base)',
          borderBottom: '1px solid var(--aiq-color-border)',
          display: 'flex',
          alignItems: 'center',
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

        {/* M4 — Desktop inline nav. Hidden on mobile via .aiq-candidate-nav-desktop
            CSS rule. Same routes as the mobile overflow menu below. */}
        <nav className="aiq-candidate-nav-desktop" aria-label="Candidate sections">
          <NavLink to="/candidate/certificates" style={navLinkStyle}>
            Certificates
          </NavLink>
          <NavLink to="/candidate/activity" style={navLinkStyle}>
            Activity
          </NavLink>
        </nav>

        <div style={{ flex: 1 }} />

        {/* Session info + sign out — right (desktop). Hidden on mobile via
            .aiq-candidate-shell-userinfo CSS rule; Sign out is reachable
            from the mobile overflow menu instead. */}
        {!loading && data !== null && (
          <div
            className="aiq-candidate-shell-userinfo"
            style={{
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

        {/* M4 — Mobile overflow menu. Hidden on desktop via .aiq-candidate-nav-mobile
            CSS rule. On mobile this is the entire right side of the header:
            menu contains Certificates / Activity / Sign out. Same handlers as
            the desktop inline controls — no behavior divergence. */}
        <div className="aiq-candidate-nav-mobile" ref={menuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            data-help-id="candidate.shell.nav.mobile_menu"
            style={{
              background: 'transparent',
              border: '1px solid var(--aiq-color-border-strong)',
              borderRadius: 'var(--aiq-radius-pill)',
              width: 32,
              height: 32,
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--aiq-color-fg-primary)',
            }}
          >
            <Icon name="drag" size={14} />
          </button>
          {menuOpen && (
            <ul
              role="menu"
              aria-label="Candidate navigation"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 8,
                minWidth: 180,
                background: 'var(--aiq-color-bg-base)',
                border: '1px solid var(--aiq-color-border)',
                borderRadius: 'var(--aiq-radius-md)',
                boxShadow: 'var(--aiq-shadow-md)',
                padding: 'var(--aiq-space-xs)',
                margin: 0,
                listStyle: 'none',
                zIndex: 101,
              }}
            >
              <li role="none">
                <NavLink
                  role="menuitem"
                  to="/candidate/certificates"
                  onClick={() => setMenuOpen(false)}
                  style={menuItemStyle}
                >
                  Certificates
                </NavLink>
              </li>
              <li role="none">
                <NavLink
                  role="menuitem"
                  to="/candidate/activity"
                  onClick={() => setMenuOpen(false)}
                  style={menuItemStyle}
                >
                  Activity
                </NavLink>
              </li>
              <li
                role="separator"
                aria-orientation="horizontal"
                style={{
                  borderTop: '1px solid var(--aiq-color-border)',
                  margin: 'var(--aiq-space-xs) 0',
                }}
              />
              <li role="none">
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleSignOut();
                  }}
                  style={{
                    ...NAV_LINK_BASE,
                    width: '100%',
                    textAlign: 'left',
                    color: 'var(--aiq-color-fg-secondary)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Sign out
                </button>
              </li>
            </ul>
          )}
        </div>
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
