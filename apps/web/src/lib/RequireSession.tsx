import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from './session';
import type { ReactNode } from 'react';

export function RequireSession({ children, role }: { children: ReactNode; role?: 'admin' | 'reviewer' }): JSX.Element {
  const session = useSession();
  const loc = useLocation();
  if (!session) return <Navigate to="/admin/login" replace state={{ from: loc.pathname }} />;
  if (!session.totpVerified && loc.pathname !== '/admin/mfa') {
    return <Navigate to="/admin/mfa" replace />;
  }
  if (role && session.role !== role) {
    return <Navigate to="/admin/login" replace />;
  }
  return <>{children}</>;
}
