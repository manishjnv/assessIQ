/* eslint-disable no-console */
/**
 * Shared session-acquisition helpers for AssessIQ load tests.
 *
 * SAFETY: This file asserts at runtime that TARGET_URL is never a production
 * hostname. The dev-mint route (/api/dev/mint-session) is disabled in prod
 * (ENABLE_E2E_TEST_MINTER must be true + NODE_ENV != 'production'). The
 * hostname check here adds a second layer so no accidental prod test can slip
 * through even if someone sets ENABLE_E2E_TEST_MINTER on the wrong server.
 */

import http from 'k6/http';

const PROD_PATTERNS = [
  'assessiq.in',
  '.automateedge.',
];

/**
 * Must be called at the top of every scenario's setup() before any request.
 * Throws (aborting the run) if TARGET_URL looks like a production host.
 */
export function assertDevOnly(targetUrl) {
  for (const pattern of PROD_PATTERNS) {
    if (targetUrl.includes(pattern)) {
      throw new Error(
        `LOAD TEST REFUSED: TARGET_URL "${targetUrl}" matches production hostname ` +
        `pattern "${pattern}". This harness must only run against localhost/127.0.0.1.`,
      );
    }
  }
  if (
    targetUrl.startsWith('https://') &&
    !targetUrl.includes('localhost') &&
    !targetUrl.includes('127.0.0.1')
  ) {
    throw new Error(
      `LOAD TEST REFUSED: TARGET_URL "${targetUrl}" uses HTTPS on a non-localhost ` +
      'host. Production URLs are never allowed in this harness.',
    );
  }
}

function cookieValue(res, name) {
  const jar = res.cookies[name];
  return jar && jar[0] && jar[0].value ? jar[0].value : null;
}

/**
 * Returns an aiq_sess cookie value for an admin user, or null on failure.
 *
 * Priority:
 *   1. LOAD_TEST_ADMIN_COOKIE env var (manual override; useful when dev DB
 *      doesn't have the loadtest user seeded)
 *   2. POST /api/dev/mint-session (requires ENABLE_E2E_TEST_MINTER=true in
 *      the dev API and a user with email loadtest-admin@wipro-soc.test in
 *      the dev DB with role=admin)
 *
 * Returns null (not an error) if minting fails — callers skip gracefully.
 */
export function mintAdminSession(baseUrl) {
  if (__ENV.LOAD_TEST_ADMIN_COOKIE) return __ENV.LOAD_TEST_ADMIN_COOKIE;

  const res = http.post(
    `${baseUrl}/api/dev/mint-session`,
    JSON.stringify({
      email: 'loadtest-admin@wipro-soc.test',
      role: 'admin',
      tenantSlug: 'wipro-soc',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.status !== 200) {
    console.warn(
      `[auth] mintAdminSession failed (HTTP ${res.status}): ${res.body}\n` +
      '  → Admin scenarios (S3, S4) will be skipped.\n' +
      '  → Fix: start dev API with ENABLE_E2E_TEST_MINTER=true and seed\n' +
      '    loadtest-admin@wipro-soc.test as admin in the dev DB,\n' +
      '    OR set LOAD_TEST_ADMIN_COOKIE=<cookie-value> env var.',
    );
    return null;
  }

  const cookie = cookieValue(res, 'aiq_sess');
  if (!cookie) {
    console.warn('[auth] mintAdminSession: aiq_sess cookie absent in 200 response — admin scenarios skipped.');
    return null;
  }
  return cookie;
}

/**
 * Returns an aiq_sess cookie value for a candidate user, or null on failure.
 *
 * Priority: LOAD_TEST_CANDIDATE_COOKIE env var, then dev-mint.
 * Dev DB must have loadtest-candidate@wipro-soc.test with role=candidate,
 * OR the mint route will create it (role=candidate is the only auto-create path).
 */
export function mintCandidateSession(baseUrl) {
  if (__ENV.LOAD_TEST_CANDIDATE_COOKIE) return __ENV.LOAD_TEST_CANDIDATE_COOKIE;

  const res = http.post(
    `${baseUrl}/api/dev/mint-session`,
    JSON.stringify({
      email: 'loadtest-candidate@wipro-soc.test',
      role: 'candidate',
      tenantSlug: 'wipro-soc',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.status !== 200) {
    console.warn(
      `[auth] mintCandidateSession failed (HTTP ${res.status}): ${res.body}\n` +
      '  → Candidate scenario (S5) will be skipped.\n' +
      '  → Fix: start dev API with ENABLE_E2E_TEST_MINTER=true,\n' +
      '    OR set LOAD_TEST_CANDIDATE_COOKIE=<cookie-value> env var.',
    );
    return null;
  }

  const cookie = cookieValue(res, 'aiq_sess');
  if (!cookie) {
    console.warn('[auth] mintCandidateSession: aiq_sess cookie absent in 200 response — candidate scenario skipped.');
    return null;
  }
  return cookie;
}
