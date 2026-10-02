import { Link, Navigate, useLocation } from 'react-router-dom';
import { useSession } from './session';
import type { ReactNode } from 'react';

// Cookie-trust gate: reads /api/auth/whoami to verify the aiq_sess cookie.
// Replaces the pre-W4 dev-mock that read sessionStorage. Behaviour matches
// the prior contract:
//   - no session  → redirect to unauthRedirect (default /admin/login),
//                   preserving from-path in state
//   - mfaStatus=pending and not on /admin/mfa → redirect to /admin/mfa
//   - role mismatch → render a "no access" notice with a link to unauthRedirect
//                     (children never render)
//
// Role hierarchy for the gate:
//   super_admin satisfies 'admin' and 'reviewer' (super_admin > admin > reviewer > candidate).
//   HOWEVER, when role === 'super_admin', ONLY a session with role === 'super_admin' passes.
//   A plain 'admin' is NOT a super_admin and must be blocked — super_admin is a
//   platform-level role above the tenant hierarchy, not a peer of admin. This asymmetry
//   prevents tenant admins from accessing platform-only routes while preserving the
//   existing behaviour for all other role gates. This is FE defense-in-depth; the
//   backend remains the real boundary.
//
// unauthRedirect (new): caller can point unauth redirects at /candidate/login
// for candidate-facing routes. Default '/admin/login' preserves prior behaviour
// for all existing admin routes.

export function RequireSession({
  children,
  role,
  unauthRedirect = '/admin/login',
}: {
  children: ReactNode;
  role?: 'admin' | 'reviewer' | 'super_admin';
  unauthRedirect?: string;
}): React.JSX.Element {
  const { session, loading } = useSession();
  const loc = useLocation();

  if (loading) {
    return (
      <div
        className="aiq-screen"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 12,
          color: 'var(--aiq-color-fg-muted)',
        }}
      >
        Loading…
      </div>
    );
  }

  const noAccess = (
    <div
      role="alert"
      className="aiq-screen"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        alignContent: 'center',
        gap: 'var(--aiq-space-md)',
        fontFamily: 'var(--aiq-font-sans)',
        fontSize: 'var(--aiq-text-md)',
        color: 'var(--aiq-color-fg-secondary)',
      }}
    >
      <p style={{ margin: 0 }}>You do not have access to this page.</p>
      <Link to={unauthRedirect} style={{ color: 'var(--aiq-color-accent)' }}>
        Sign in with a different account
      </Link>
    </div>
  );

  if (!session) {
    return <Navigate to={unauthRedirect} replace state={{ from: loc.pathname }} />;
  }

  if (session.mfaStatus === 'pending' && loc.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace />;
  }

  // Role gate — asymmetric by design (see comment above):
  //   role === 'super_admin': exact match only — admin must NOT pass this gate.
  //   role === 'admin' | 'reviewer': super_admin satisfies the gate (super_admin > admin > reviewer).
  if (role !== undefined) {
    const isSuperAdmin = session.user.role === 'super_admin';
    if (role === 'super_admin') {
      // Exact-match: only super_admin passes. A plain admin sees the notice.
      if (!isSuperAdmin) {
        return noAccess;
      }
    } else if (session.user.role !== role && !isSuperAdmin) {
      // For other roles, super_admin satisfies the gate.
      return noAccess;
    }
  }

  return <>{children}</>;
}
