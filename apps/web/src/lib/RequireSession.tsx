import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from './session';
import type { ReactNode } from 'react';

// Cookie-trust gate: reads /api/auth/whoami to verify the aiq_sess cookie.
// Replaces the pre-W4 dev-mock that read sessionStorage. Behaviour matches
// the prior contract:
//   - no session  → redirect to /admin/login (preserving from-path in state)
//   - mfaStatus=pending and not on /admin/mfa → redirect to /admin/mfa
//   - role mismatch → redirect to /admin/login

export function RequireSession({
  children,
  role,
}: {
  children: ReactNode;
  role?: 'admin' | 'reviewer';
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
    return <Navigate to="/admin/login" replace state={{ from: loc.pathname }} />;
  }

  if (session.mfaStatus === 'pending' && loc.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace />;
  }

  if (role !== undefined && session.user.role !== role) {
    return <Navigate to="/admin/login" replace />;
  }

  return <>{children}</>;
}
