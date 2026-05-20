/* eslint-disable no-console */
/**
 * AssessIQ rate-limit boundary probe — anonymous IP bucket.
 *
 * Ramps VUs from 5 → 15 → 0 to observe exactly where the 30 req/min/IP
 * anonymous bucket fires. Check the console output for 429 log lines and
 * the k6 summary for the error rate inflection point.
 *
 * This is a DIAGNOSTIC scenario, not a pass/fail gate. No hard latency
 * thresholds are set — review the output manually.
 *
 * Run standalone (do NOT combine with smoke.js — they share the anon bucket):
 *   k6 run tests/load/scenarios/auth-flow.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { assertDevOnly } from '../lib/auth.js';

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '10s', target: 5 },   // warm up below the 30/min threshold
    { duration: '20s', target: 15 },  // ramp past the threshold; 429s start here
    { duration: '10s', target: 0 },   // drain
  ],
  thresholds: {
    // Diagnostic only — allow any error rate so the run always finishes.
    'http_req_failed': ['rate<1.0'],
  },
};

export function setup() {
  assertDevOnly(TARGET_URL);
}

export default function () {
  const res = http.get(`${TARGET_URL}/api/health`);

  check(res, {
    'status 200 or 429':       (r) => r.status === 200 || r.status === 429,
    'Retry-After present on 429': (r) =>
      r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });

  if (res.status === 429) {
    console.log(
      `[rate-limit] 429  VU=${__VU}  iter=${__ITER}  ` +
      `Retry-After=${res.headers['Retry-After'] || 'absent'}`,
    );
  }
}
