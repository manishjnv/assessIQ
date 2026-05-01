import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, TENANT_FIXTURES } from '@assessiq/ui-system';
import { AdminLogin } from './pages/admin/login';
import { AdminMfa } from './pages/admin/mfa';
import { AdminUsers } from './pages/admin/users';
import { InviteAccept } from './pages/invite-accept';
import { RequireSession } from './lib/RequireSession';

const tenant = TENANT_FIXTURES['wipro-soc'];

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <ThemeProvider
        theme="system"
        density="cozy"
        {...(tenant?.branding ? { branding: tenant.branding } : {})}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/admin/login" replace />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/mfa" element={<RequireSession><AdminMfa /></RequireSession>} />
          <Route path="/admin/users" element={<RequireSession role="admin"><AdminUsers /></RequireSession>} />
          <Route path="/admin/invite/accept" element={<InviteAccept />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ThemeProvider>
    </BrowserRouter>
  );
}

function NotFound(): JSX.Element {
  return <div className="aiq-screen" style={{ padding: 32 }}>Not found.</div>;
}
