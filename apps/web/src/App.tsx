import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router';
import { ThemeProvider, TENANT_FIXTURES, accentBranding } from '@assessiq/ui-system';
import { AdminLogin } from './pages/admin/login';
import { AdminSelectIdentity } from './pages/admin/select-identity';
import { CandidateLogin } from './pages/candidate/CandidateLogin';
import { RequireSession } from './lib/RequireSession';
import { useCachedSession } from './lib/session';
import { Expired } from './pages/take/Expired';
import { ErrorPage as TakeError } from './pages/take/ErrorPage';
import { TakeRoot } from './pages/take/TakeRoot';
import { ErrorBoundary } from './components/ErrorBoundary';

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
const AdminQuestionReview = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminQuestionReview })));
const AdminCreateTest = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminCreateTest })));
const AdminAssessments = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAssessments })));
const AdminAssessmentDetail = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAssessmentDetail })));
const AdminReports = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminReports })));
const AdminGenerationAttempts = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminGenerationAttempts })));
const AdminCertificates = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminCertificates })));
const AdminActivity = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminActivity })));
const AdminMockResults = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminMockResults })));
const AdminUsers = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminUsers })));
const AdminTenantSettings = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminTenantSettings })));
const AdminCameraReview = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminCameraReview })));
const AdminGenerateWizard = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminGenerateWizard })));
const AdminPlatform = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminPlatform })));
const AdminQuestionImport = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminQuestionImport })));
const AdminExamBlueprints = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminExamBlueprints })));
const OrgQuestionUpload = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.OrgQuestionUpload })));
const ReviewQueue = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.ReviewQueue })));
const SuperAdminUsers = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.SuperAdminUsers })));
const AdminAccountSecurity = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAccountSecurity })));
const AdminEvaluationsQueue = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminEvaluationsQueue })));
const AdminEvaluationDetail = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminEvaluationDetail })));
const AdminAuditLog = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminAuditLog })));
const AdminWebhooks = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminWebhooks })));
const AdminEmbedConfig = lazy(() => import('@assessiq/admin-dashboard').then(m => ({ default: m.AdminEmbedConfig })));

const MyCertificates = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.MyCertificates })));
const MyResults = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.MyResults })));
const MyProgress = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.MyProgress })));
const CandidateShell = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.CandidateShell })));
const CandidateActivity = lazy(() => import('@assessiq/candidate-ui').then(m => ({ default: m.CandidateActivity })));

const AdminMfa = lazy(() => import('./pages/admin/mfa').then(m => ({ default: m.AdminMfa })));
const AdminEmailOtp = lazy(() => import('./pages/admin/email-otp').then(m => ({ default: m.AdminEmailOtp })));
const CandidateLoginVerify = lazy(() => import('./pages/candidate/CandidateLoginVerify').then(m => ({ default: m.CandidateLoginVerify })));
const InviteAccept = lazy(() => import('./pages/invite-accept').then(m => ({ default: m.InviteAccept })));
const AttemptPage = lazy(() => import('./pages/take/Attempt').then(m => ({ default: m.AttemptPage })));
const Submitted = lazy(() => import('./pages/take/Submitted').then(m => ({ default: m.Submitted })));
const TokenLanding = lazy(() => import('./pages/take/TokenLanding').then(m => ({ default: m.TokenLanding })));

const CheckPage = lazy(() => import('./pages/check/Check').then(m => ({ default: m.CheckPage })));
const TryPage = lazy(() => import('./pages/try/Try').then(m => ({ default: m.TryPage })));
const TryCertificatePage = lazy(() => import('./pages/try/TryCertificate').then(m => ({ default: m.TryCertificatePage })));

const tenant = TENANT_FIXTURES['default'];

/** Z-119: real org accent from whoami (or the admin settings save event); default theme when absent or below 4.5:1. */
function useOrgBranding() {
  const session = useCachedSession();
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const on = (e: Event): void => setSaved((e as CustomEvent<string | null>).detail);
    window.addEventListener('aiq:accent', on);
    return () => window.removeEventListener('aiq:accent', on);
  }, []);
  const tenantId = session?.tenant.id;
  useEffect(() => setSaved(undefined), [tenantId]);
  return accentBranding(saved !== undefined ? saved : session?.tenant.accent) ?? tenant?.branding;
}

export function App(): React.JSX.Element {
  const branding = useOrgBranding();
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
        {...(branding ? { branding } : {})}
      >
        <ErrorBoundary>
        <Suspense fallback={null}>
          {/* Admin Mobile Port (A6, 2026-05-21) deleted the M5 ViewportLock
              wrapper that intercepted /admin/* on mobile. Admin pages are
              now mobile-responsive (see docs/plans/archive/ADMIN_MOBILE_PORT.md). */}
          <Routes>
          <Route path="/" element={<Navigate to="/admin/login" replace />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          {/* P1 — identity picker for multi-tenant Google login; no RequireSession */}
          <Route path="/admin/select-identity" element={<AdminSelectIdentity />} />
          {/* P2 — email-OTP login (admin only); no RequireSession (pre-session) */}
          <Route path="/admin/login/email" element={<AdminEmailOtp />} />
          <Route path="/admin/mfa" element={<RequireSession><AdminMfa /></RequireSession>} />
          <Route path="/admin/users" element={<RequireSession role="admin"><AdminUsers /></RequireSession>} />
          <Route path="/admin/tenant-settings" element={<RequireSession role="admin"><AdminTenantSettings /></RequireSession>} />
          <Route path="/admin" element={<RequireSession role="admin"><AdminDashboard /></RequireSession>} />
          <Route path="/admin/attempts" element={<RequireSession role="admin"><AdminAttempts /></RequireSession>} />
          <Route path="/admin/attempts/:id" element={<RequireSession role="admin"><AdminAttemptDetail /></RequireSession>} />
          <Route path="/admin/grading-jobs" element={<RequireSession role="admin"><AdminGradingJobs /></RequireSession>} />
          <Route path="/admin/reports/cohort/:assessmentId" element={<RequireSession role="admin"><AdminCohortReport /></RequireSession>} />
          <Route path="/admin/reports/individual/:userId" element={<RequireSession role="admin"><AdminIndividualReport /></RequireSession>} />
          <Route path="/admin/question-bank/questions/:id" element={<RequireSession role="admin"><AdminQuestionEditor /></RequireSession>} />
          <Route path="/admin/settings" element={<RequireSession role="admin"><AdminBilling /></RequireSession>} />
          {/* Back-compat: old /admin/settings/billing bookmarks → the Plan and usage tab (Z-23) */}
          <Route path="/admin/settings/billing" element={<Navigate to="/admin/settings?tab=plan" replace />} />
          <Route path="/admin/settings/help-content" element={<RequireSession role="super_admin"><AdminHelpContent /></RequireSession>} />
          <Route path="/admin/guide" element={<RequireSession role="admin"><AdminShell breadcrumbs={["Help guide"]}><AdminGuide /></AdminShell></RequireSession>} />
          {/* Question Bank pages (session 2026-05-04) */}
          <Route path="/admin/question-bank" element={<RequireSession role="admin"><AdminQuestionBank /></RequireSession>} />
          {/* /admin/question-bank/questions/:id must come before /:id to match literal segment */}
          <Route path="/admin/question-bank/:id/review" element={<RequireSession role="admin"><AdminQuestionReview /></RequireSession>} />
          <Route path="/admin/question-bank/:id" element={<RequireSession role="admin"><AdminPackDetail /></RequireSession>} />
          {/* Assessments (Cycles) pages (session 2026-05-04) */}
          <Route path="/admin/start-test" element={<Navigate to="/admin/create-test" replace />} />
          <Route path="/admin/create-test" element={<RequireSession role="admin"><AdminCreateTest /></RequireSession>} />
          <Route path="/admin/assessments" element={<RequireSession role="admin"><AdminAssessments /></RequireSession>} />
          <Route path="/admin/assessments/:id" element={<RequireSession role="admin"><AdminAssessmentDetail /></RequireSession>} />
          {/* Reports landing (session 2026-05-04) */}
          <Route path="/admin/reports" element={<RequireSession role="admin"><AdminReports /></RequireSession>} />
          {/* AI generation history — Phase B1: re-gated to super_admin */}
          <Route path="/admin/generation-attempts" element={<RequireSession role="super_admin"><AdminGenerationAttempts /></RequireSession>} />
          {/* Generate Question Wizard — Phase B1: re-gated to super_admin */}
          <Route path="/admin/generate-wizard" element={<RequireSession role="super_admin"><AdminGenerateWizard /></RequireSession>} />
          <Route path="/admin/question-import" element={<RequireSession role="super_admin"><AdminQuestionImport /></RequireSession>} />
          <Route path="/admin/exam-blueprints" element={<RequireSession role="super_admin"><AdminExamBlueprints /></RequireSession>} />
          <Route path="/admin/org-question-upload" element={<RequireSession role="admin"><OrgQuestionUpload /></RequireSession>} />
          <Route path="/admin/review-queue" element={<RequireSession role="admin"><ReviewQueue /></RequireSession>} />
          {/* Certificates admin (Phase 5 Session 5) — AdminCertificates wraps AdminShell internally */}
          <Route path="/admin/certificates" element={<RequireSession role="admin"><AdminCertificates /></RequireSession>} />
          {/* Activity page (Phase 11) */}
          <Route path="/admin/activity" element={<RequireSession role="admin"><AdminActivity /></RequireSession>} />
          {/* Mock results (Z-90) */}
          <Route path="/admin/mock-results" element={<RequireSession role="admin"><AdminMockResults /></RequireSession>} />
          {/* Audit log — RW-25 admin audit trail */}
          <Route path="/admin/audit-log" element={<RequireSession role="admin"><AdminAuditLog /></RequireSession>} />
          {/* Webhooks — RW-25 integrations */}
          <Route path="/admin/integrations/webhooks" element={<RequireSession role="admin"><AdminWebhooks /></RequireSession>} />
          {/* Embed configuration — RW-25 integrations */}
          <Route path="/admin/integrations/embed" element={<RequireSession role="admin"><AdminEmbedConfig /></RequireSession>} />
          {/* Platform provisioning — super_admin only (exact-match gate) */}
          <Route path="/admin/camera-review" element={<RequireSession role="admin"><AdminCameraReview /></RequireSession>} />
          <Route path="/admin/platform" element={<RequireSession role="super_admin"><AdminPlatform /></RequireSession>} />
          {/* Evaluation queue — AssessIQ evaluates written answers across all
              companies (super_admin only); companies review and publish. */}
          <Route path="/admin/platform/evaluations" element={<RequireSession role="super_admin"><AdminEvaluationsQueue /></RequireSession>} />
          <Route path="/admin/platform/evaluations/:attemptId" element={<RequireSession role="super_admin"><AdminEvaluationDetail /></RequireSession>} />
          {/* Phase C — super-admin per-tenant user drill-down */}
          <Route path="/admin/account-security" element={<RequireSession role="admin"><AdminAccountSecurity /></RequireSession>} />
          <Route path="/admin/platform/:tenantId/users" element={<RequireSession role="super_admin"><SuperAdminUsers /></RequireSession>} />
          <Route path="/admin/invite/accept" element={<InviteAccept />} />

          {/* Candidate auth routes — no RequireSession (public pages). */}
          <Route path="/candidate/login" element={<CandidateLogin />} />
          <Route path="/candidate/login/verify" element={<CandidateLoginVerify />} />

          {/* Candidate results — released results only (owner rule P1). This is
              where the emailed magic-link sign-in lands (verify-link redirects
              here). Same gate as certificates below. */}
          <Route
            path="/candidate/results"
            element={
              <RequireSession unauthRedirect="/candidate/login">
                <CandidateShell>
                  <MyResults />
                </CandidateShell>
              </RequireSession>
            }
          />

          {/* Candidate progress — released attempts only (RW-84). */}
          <Route
            path="/candidate/progress"
            element={
              <RequireSession unauthRedirect="/candidate/login">
                <CandidateShell>
                  <MyProgress />
                </CandidateShell>
              </RequireSession>
            }
          />

          {/* Candidate certificate dashboard.
              RequireSession with no role admits any authenticated user
              (super_admin > admin > candidate). Unauthenticated
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

          {/* Z-154: public device check (no token, no session). Needs /check in the Caddy @app matcher. */}
          <Route path="/check" element={<CheckPage />} />

          {/* Public demo (no RequireSession, no API calls). Needs /try + /try/* in the Caddy @app matcher. */}
          <Route path="/try" element={<TryPage />} />
          <Route path="/try/certificate" element={<TryCertificatePage />} />

          <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </ThemeProvider>
    </BrowserRouter>
  );
}

function NotFound(): React.JSX.Element {
  return (
    <main
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
          fontSize: 'var(--aiq-h1-size)',
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
    </main>
  );
}
