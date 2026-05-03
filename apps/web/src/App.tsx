import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, TENANT_FIXTURES } from '@assessiq/ui-system';
import { AdminLogin } from './pages/admin/login';
import { AdminMfa } from './pages/admin/mfa';
import { AdminUsers } from './pages/admin/users';
import {
  AdminDashboard,
  AdminAttempts,
  AdminAttemptDetail,
  AdminGradingJobs,
  AdminCohortReport,
  AdminIndividualReport,
  AdminQuestionEditor,
  AdminBilling,
  AdminHelpContent,
} from '@assessiq/admin-dashboard';
import { InviteAccept } from './pages/invite-accept';
import { RequireSession } from './lib/RequireSession';
import {
  TokenLanding,
  Expired,
  ErrorPage as TakeError,
  AttemptPage,
  Submitted,
  TakeRoot,
} from './pages/take';

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
          <Route path="/admin" element={<RequireSession role="admin"><AdminDashboard /></RequireSession>} />
          <Route path="/admin/attempts" element={<RequireSession role="admin"><AdminAttempts /></RequireSession>} />
          <Route path="/admin/attempts/:id" element={<RequireSession role="admin"><AdminAttemptDetail /></RequireSession>} />
          <Route path="/admin/grading-jobs" element={<RequireSession role="admin"><AdminGradingJobs /></RequireSession>} />
          <Route path="/admin/reports/cohort/:assessmentId" element={<RequireSession role="admin"><AdminCohortReport /></RequireSession>} />
          <Route path="/admin/reports/individual/:userId" element={<RequireSession role="admin"><AdminIndividualReport /></RequireSession>} />
          <Route path="/admin/question-bank/questions/:id" element={<RequireSession role="admin"><AdminQuestionEditor /></RequireSession>} />
          <Route path="/admin/settings/billing" element={<RequireSession role="admin"><AdminBilling /></RequireSession>} />
          <Route path="/admin/settings/help-content" element={<RequireSession role="admin"><AdminHelpContent /></RequireSession>} />
          <Route path="/admin/invite/accept" element={<InviteAccept />} />

          {/* Candidate /take/* subtree.
              <TakeRoot> mounts <HelpProvider> over the entire candidate flow.
              Static literal routes (expired/error) are listed BEFORE the
              dynamic :token route — RR v6's specificity match would prefer
              the literal anyway, but explicit ordering keeps the intent
              obvious to future readers.
              The candidate session is minted server-side by POST /api/take/start
              (Session 4b deliverable) — no <RequireSession> wrapper here. */}
          <Route path="/take" element={<TakeRoot />}>
            <Route index element={<Navigate to="/" replace />} />
            <Route path="expired" element={<Expired />} />
            <Route path="error" element={<TakeError />} />
            <Route path="attempt/:id" element={<AttemptPage />} />
            <Route path="attempt/:id/submitted" element={<Submitted />} />
            <Route path=":token" element={<TokenLanding />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </ThemeProvider>
    </BrowserRouter>
  );
}

function NotFound(): JSX.Element {
  return <div className="aiq-screen" style={{ padding: 32 }}>Not found.</div>;
}
