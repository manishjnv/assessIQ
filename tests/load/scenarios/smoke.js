/**
 * AssessIQ smoke baseline — 5 scenarios, 30s each.
 *
 * Purpose: establish p50/p95/p99 + RPS + error-rate baselines for the five
 * most representative request paths against the LOCAL dev environment.
 *
 * NOT for production. NOT a stress test. NOT a soak test.
 * See tests/load/README.md for thresholds, interpretation, and safety rules.
 *
 * Run:
 *   k6 run tests/load/scenarios/smoke.js
 *   TARGET_URL=http://localhost:3000 k6 run tests/load/scenarios/smoke.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { assertDevOnly, mintAdminSession, mintCandidateSession } from '../lib/auth.js';

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    // S1 — GET /api/health (anonymous)
    // 10 VUs with no sleep → exceeds the 30 req/min/IP anonymous bucket.
    // PURPOSE: confirm the rate-limiter fires. 429s are EXPECTED here.
    // Do not use S1 latency numbers as a performance baseline.
    'health-liveness': {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      exec: 'healthLiveness',
    },

    // S2 — POST /api/auth/candidate/request-link (anonymous)
    // Always returns 204 by design (anti-enumeration). A 429 here means the
    // shared anonymous IP bucket (depleted by S1) fired before the endpoint.
    // Rotating email per iteration avoids the per-(IP,email) 5/60min sub-limit.
    'magic-link-request': {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      exec: 'magicLinkRequest',
    },

    // S3 — GET /api/auth/whoami (admin session)
    // Redis session lookup. Primary signal for session-layer latency.
    // Admin bucket: 100 req/min/IP — 5 VUs will not exceed this.
    'admin-whoami': {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      exec: 'adminWhoami',
    },

    // S4 — GET /api/admin/users (admin session)
    // First Postgres + RLS read in the critical admin path.
    'admin-user-list': {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      exec: 'adminUserList',
    },

    // S5 — GET /api/me/assessments (candidate session)
    // Candidate hot path. Candidate bucket: 30 req/min/IP — 3 VUs will not
    // exceed this at the default iteration pacing.
    'candidate-assessments': {
      executor: 'constant-vus',
      vus: 3,
      duration: '30s',
      exec: 'candidateAssessments',
    },
  },

  thresholds: {
    // S1: anonymous bucket is intentionally exhausted — 429s expected.
    'http_req_failed{scenario:health-liveness}': ['rate<0.95'],

    // S2: anonymous bucket shared with S1 → spillover 429s are expected.
    // When requests DO reach the endpoint they return 204 in ~200ms.
    'http_req_failed{scenario:magic-link-request}': ['rate<0.80'],

    // S3–S5: authenticated tiers. Near-zero errors required.
    'http_req_failed{scenario:admin-whoami}':          ['rate<0.05'],
    'http_req_failed{scenario:admin-user-list}':       ['rate<0.05'],
    'http_req_failed{scenario:candidate-assessments}': ['rate<0.05'],

    // Latency — smoke baselines, NOT SLOs. See README for interpretation.
    'http_req_duration{scenario:admin-whoami}':          ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:admin-user-list}':       ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:candidate-assessments}': ['p(95)<500', 'p(99)<1000'],

    // Magic-link has a mandatory 200ms server-side floor (anti-enumeration).
    'http_req_duration{scenario:magic-link-request}': ['p(95)<600', 'p(99)<1500'],
  },
};

export function setup() {
  assertDevOnly(TARGET_URL);
  return {
    adminCookie: mintAdminSession(TARGET_URL),
    candidateCookie: mintCandidateSession(TARGET_URL),
  };
}

// S1 — anonymous; 429 is an expected outcome
export function healthLiveness() {
  const res = http.get(`${TARGET_URL}/api/health`);
  check(res, { 'status 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

// S2 — anonymous; rotating email sidesteps per-(IP,email) sub-limit
export function magicLinkRequest() {
  const email = `lt-${__VU}-${__ITER}@wipro-soc.test`;
  const res = http.post(
    `${TARGET_URL}/api/auth/candidate/request-link`,
    JSON.stringify({ email, tenant_slug: 'wipro-soc' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // 204 = endpoint reached (anti-enumeration response)
  // 429 = anon IP bucket exhausted by S1 before request hit the endpoint
  check(res, { 'status 204 or 429': (r) => r.status === 204 || r.status === 429 });
  sleep(2);
}

// S3 — admin session; Redis round-trip
export function adminWhoami(data) {
  if (!data.adminCookie) return;
  const res = http.get(`${TARGET_URL}/api/auth/whoami`, {
    headers: { Cookie: `aiq_sess=${data.adminCookie}` },
  });
  check(res, { 'whoami 200': (r) => r.status === 200 });
}

// S4 — admin session; Postgres + RLS read
export function adminUserList(data) {
  if (!data.adminCookie) return;
  const res = http.get(`${TARGET_URL}/api/admin/users?pageSize=20`, {
    headers: { Cookie: `aiq_sess=${data.adminCookie}` },
  });
  check(res, { 'users 200': (r) => r.status === 200 });
}

// S5 — candidate session; candidate hot path
export function candidateAssessments(data) {
  if (!data.candidateCookie) return;
  const res = http.get(`${TARGET_URL}/api/me/assessments`, {
    headers: { Cookie: `aiq_sess=${data.candidateCookie}` },
  });
  check(res, { 'assessments 200': (r) => r.status === 200 });
}
