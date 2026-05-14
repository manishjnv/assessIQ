import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { ThemeProvider, TENANT_FIXTURES } from '@assessiq/ui-system';
import { AdminLogin } from './pages/admin/login';
import { AdminMfa } from './pages/admin/mfa';

// Lazy-loaded so the admin-dashboard chunk is not downloaded on unauthenticated
// pages (/admin/login, /candidate/login, error pages). Cuts initial bundle by
// ~130 KB and brings FCP/LCP on those routes under the ≥ 0.90 Lighthouse gate.
// All lazy() calls targeting the same specifier merge into one chunk in Rollup.
const AdminDashboard = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminDashboard })));
const AdminAttempts = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAttempts })));
const AdminAttemptDetail = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAttemptDetail })));
const AdminGradingJobs = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminGradingJobs })));
const AdminCohortReport = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminCohortReport })));
const AdminIndividualReport = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminIndividualReport })));
const AdminQuestionEditor = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminQuestionEditor })));
const AdminBilling = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminBilling })));
const AdminHelpContent = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminHelpContent })));
const AdminGuide = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminGuide })));
const AdminShell = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminShell })));
const AdminQuestionBank = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminQuestionBank })));
const AdminPackDetail = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminPackDetail })));
const AdminAssessments = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAssessments })));
const AdminAssessmentDetail = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAssessmentDetail })));
const AdminReports = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminReports })));
const AdminGenerationAttempts = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminGenerationAttempts })));
const AdminCertificates = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminCertificates })));
const AdminActivity = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminActivity })));
const AdminUsers = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminUsers })));

const MyCertificates = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.MyCertificates })));
const CandidateShell = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.CandidateShell })));
const CandidateActivity = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.CandidateActivity })));
import { CandidateLogin } from './pages/candidate/CandidateLogin';
import { CandidateLoginVerify } from './pages/candidate/CandidateLoginVerify';
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
          AssessIQ_UI_Template/screens/* ship light-mode tokens only; the
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
        <Suspense fallback={null}>
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
          <Route path="/admin/guide" element={<RequireSession role="admin"><AdminShell breadcrumbs={["Help guide"]}><AdminGuide /></AdminShell></RequireSession>} />
          {/* Question Bank pages (session 2026-05-04) */}
          <Route path="/admin/question-bank" element={<RequireSession role="admin"><AdminQuestionBank /></RequireSession>} />
          {/* /admin/question-bank/questions/:id must come before /:id to match literal segment */}
          <Route path="/admin/question-bank/:id" element={<RequireSession role="admin"><AdminPackDetail /></RequireSession>} />
          {/* Assessments (Cycles) pages (session 2026-05-04) */}
          <Route path="/admin/assessments" element={<RequireSession role="admin"><AdminAssessments /></RequireSession>} />
          <Route path="/admin/assessments/:id" element={<RequireSession role="admin"><AdminAssessmentDetail /></RequireSession>} />
          {/* Reports landing (session 2026-05-04) */}
          <Route path="/admin/reports" element={<RequireSession role="admin"><AdminReports /></RequireSession>} />
          {/* AI generation history (session 2026-05-09) */}
          <Route path="/admin/generation-attempts" element={<RequireSession role="admin"><AdminGenerationAttempts /></RequireSession>} />
          {/* Certificates admin (Phase 5 Session 5) — AdminCertificates wraps AdminShell internally */}
          <Route path="/admin/certificates" element={<RequireSession role="admin"><AdminCertificates /></RequireSession>} />
          {/* Activity page (Phase 11) */}
          <Route path="/admin/activity" element={<RequireSession role="admin"><AdminActivity /></RequireSession>} />
          <Route path="/admin/invite/accept" element={<InviteAccept />} />

          {/* Candidate auth routes — no RequireSession (public pages). */}
          <Route path="/candidate/login" element={<CandidateLogin />} />
          <Route path="/candidate/login/verify" element={<CandidateLoginVerify />} />

          {/* Candidate certificate dashboard.
              RequireSession with no role admits any authenticated user
              (super_admin > admin > reviewer > candidate). Unauthenticated
              candidates now redirect to /candidate/login (magic-link flow). */}
          <Route
            path="/candidate/certificates"
            element={
              <RequireSession unauthRedirect="/candidate/login">
                <CandidateShell>
                  <MyCertificates />
                </CandidateShell>
              </RequireSession>
            }
          />

          {/* Candidate activity page (Phase 12) — CandidateActivity wraps CandidateShell internally. */}
          <Route
            path="/candidate/activity"
            element={
              <RequireSession unauthRedirect="/candidate/login">
                <CandidateActivity />
              </RequireSession>
            }
          />

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
        </Suspense>
      </ThemeProvider>
    </BrowserRouter>
  );
}

function NotFound(): JSX.Element {
  return (
    <div
      className="aiq-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 32,
        textAlign: 'center',
        background: 'var(--aiq-color-bg-base)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--aiq-font-mono)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--aiq-color-fg-muted)',
          marginBottom: 12,
        }}
      >
        404
      </div>
      <h1
        style={{
          fontFamily: 'var(--aiq-font-serif)',
          fontSize: 'var(--aiq-text-3xl)',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          margin: '0 0 12px',
          color: 'var(--aiq-color-fg-primary)',
        }}
      >
        Page not found.
      </h1>
      <p
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 'var(--aiq-text-sm)',
          color: 'var(--aiq-color-fg-muted)',
          margin: '0 0 24px',
        }}
      >
        The page you're looking for doesn't exist or has been moved.
      </p>
      <Link
        to="/admin"
        style={{
          fontFamily: 'var(--aiq-font-sans)',
          fontSize: 'var(--aiq-text-sm)',
          fontWeight: 500,
          color: 'var(--aiq-color-accent)',
          textDecoration: 'none',
        }}
      >
        ← Go to dashboard
      </Link>
    </div>
  );
}
