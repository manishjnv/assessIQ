import { type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Chip, useViewport } from '@assessiq/ui-system';

// ViewportLock — M5 of the Mobile Kit Port (docs/plans/MOBILE_KIT_PORT.md).
//
// Renders a friendly "Admin tools work best on desktop" interstitial when ALL
// of the following hold:
//   - The current viewport is `mobile` (M0's data-viewport mechanism).
//   - The current path starts with `/admin/`.
//   - The path is NOT one of the auth/MFA routes admins legitimately use on
//     the go (login / select-identity / mfa / email-OTP).
//   - There is no `aiq_admin_mobile_override='1'` set in sessionStorage.
//   - We are not in embed mode (`?embed=true` — its own viewport contract).
//
// Otherwise, pass-through children. Desktop, candidate portal, take-flow,
// and the public 404 all render unchanged.
//
// Override semantics: sessionStorage (per-tab/per-session, not localStorage).
// The plan called for "session-only" and `localStorage` is contradictory to
// that — sessionStorage gives true per-tab behavior. The override clears
// when the tab closes; there is no server-side state.

const EXCLUDED_PATHS: ReadonlySet<string> = new Set([
  '/admin/login',
  '/admin/login/email',
  '/admin/select-identity',
  '/admin/mfa',
]);

const OVERRIDE_KEY = 'aiq_admin_mobile_override';

function readOverride(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage?.getItem(OVERRIDE_KEY) === '1';
  } catch {
    // sessionStorage can throw in some iframe / privacy contexts; fail closed
    // (show the interstitial — user can still tap "Continue anyway" which
    // will reload; if storage stays unavailable, the loop is benign because
    // the user can also just open the link on desktop instead).
    return false;
  }
}

function setOverrideAndReload(): void {
  try {
    window.sessionStorage?.setItem(OVERRIDE_KEY, '1');
  } catch {
    // No-op on storage failure — reload below will land back here and the
    // user can refresh or switch to desktop. Storage-blocked browsers are
    // rare enough that we don't surface an error UI for this case.
  }
  window.location.reload();
}

function Interstitial(): JSX.Element {
  return (
    <div
      className="aiq-screen aiq-admin-mobile-interstitial"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--aiq-page-padding-y) var(--aiq-page-padding-x)',
        background: 'var(--aiq-color-bg-base)',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 480, width: '100%' }}>
        <span style={{ display: 'inline-block', marginBottom: 'var(--aiq-space-lg)' }}>
          <Chip variant="default">Admin · desktop recommended</Chip>
        </span>
        <h1
          className="aiq-serif"
          style={{
            fontSize: 'var(--aiq-h1-size)',
            lineHeight: 1.1,
            margin: '0 0 var(--aiq-space-md)',
            fontWeight: 400,
            letterSpacing: '-0.02em',
          }}
        >
          Admin tools work best on desktop.
        </h1>
        <p
          style={{
            color: 'var(--aiq-color-fg-secondary)',
            fontSize: 15,
            lineHeight: 1.5,
            margin: '0 0 var(--aiq-space-xl)',
            fontFamily: 'var(--aiq-font-sans)',
          }}
        >
          The admin console is built around multi-column tables, side-by-side
          reports, and keyboard navigation. On a phone, everything is too small
          to use comfortably. Open this link on a laptop for the best
          experience. If you are a candidate looking for your certificates or
          an assessment invitation, sign in through the candidate portal.
        </p>
        <Link
          to="/candidate/login"
          style={{
            textDecoration: 'none',
            display: 'block',
            marginBottom: 'var(--aiq-space-md)',
          }}
        >
          <Button variant="primary" size="lg" style={{ width: '100%', justifyContent: 'center' }}>
            Go to candidate portal
          </Button>
        </Link>
        <button
          type="button"
          onClick={setOverrideAndReload}
          data-help-id="admin.shell.mobile_continue_anyway"
          aria-label="Continue to admin tools anyway"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--aiq-color-fg-muted)',
            fontFamily: 'var(--aiq-font-sans)',
            fontSize: 13,
            textDecoration: 'underline',
            padding: 'var(--aiq-space-sm)',
          }}
        >
          Continue anyway →
        </button>
      </div>
    </div>
  );
}

export function ViewportLock({ children }: { children: ReactNode }): JSX.Element {
  const viewport = useViewport();
  const { pathname, search } = useLocation();

  const isMobile = viewport === 'mobile';
  const isAdminRoute = pathname.startsWith('/admin');
  const isExcluded = EXCLUDED_PATHS.has(pathname);
  const isEmbed = new URLSearchParams(search).get('embed') === 'true';
  const hasOverride = readOverride();

  const showInterstitial =
    isMobile && isAdminRoute && !isExcluded && !isEmbed && !hasOverride;

  if (showInterstitial) return <Interstitial />;
  return <>{children}</>;
}
