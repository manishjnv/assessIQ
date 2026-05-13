import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from './session';
import type { ReactNode } from 'react';

// Cookie-trust gate: reads /api/auth/whoami to verify the aiq_sess cookie.
// Replaces the pre-W4 dev-mock that read sessionStorage. Behaviour matches
// the prior contract:
//   - no session  → redirect to unauthRedirect (default /admin/login),
//                   preserving from-path in state
//   - mfaStatus=pending and not on /admin/mfa → redirect to /admin/mfa
//   - role mismatch → redirect to unauthRedirect
//
// super_admin satisfies any role gate: super_admin > admin > reviewer > candidate.
// This avoids forking every route guard when platform operators need access.
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
  role?: 'admin' | 'reviewer';
  unauthRedirect?: string;
}): JSX.Element {
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

  if (!session) {
    return <Navigate to={unauthRedirect} replace state={{ from: loc.pathname }} />;
  }

  if (session.mfaStatus === 'pending' && loc.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace />;
  }

  // super_admin satisfies any role requirement (super_admin > admin > reviewer).
  const isSuperAdmin = session.user.role === 'super_admin';
  if (role !== undefined && session.user.role !== role && !isSuperAdmin) {
    return <Navigate to={unauthRedirect} replace />;
  }

  return <>{children}</>;
}
