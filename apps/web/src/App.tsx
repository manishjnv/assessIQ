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
      {/* theme="light" pinned per docs/10-branding-guideline.md § 0 + § 1 —
          AccessIQ_UI_Template/screens/* ship light-mode tokens only; the
          canonical visual identity is "white-on-white surfaces" with the
          indigo-violet accent. Auto-system would resolve dark on a Windows
          11 box and override --aiq-color-bg-base via [data-theme="dark"]
          (tokens.css:93+), giving the SPA a black background that diverges
          from the template. Dark mode is opt-in per-user (Phase 1+) and
          only after the template adds dark variants of every screen. */}
      <ThemeProvider
        theme="light"
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
