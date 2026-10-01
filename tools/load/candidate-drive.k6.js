// AssessIQ campus-drive load simulation (k6).
//
// Simulates N candidates (default 300) sitting in ONE computer lab (so the
// server sees them behind a single public IP): each opens a magic link, begins
// the attempt, autosaves every ~5 s for the test duration (default 10 min),
// then submits. Mirrors the real SPA: POST /take/start (preview), POST
// /take/start (begin), GET /api/me/attempts/:id, POST /api/me/attempts/:id/answer
// every 5 s (useAutosave debounce), POST /api/me/attempts/:id/submit.
//
// !! STAGING / LOCAL STACK ONLY. NEVER point this at production. !!
// It consumes real magic-link tokens, creates attempts and submits them, and
// deliberately concentrates all traffic on one IP to exercise the campus-scale
// rate limits (RATE_LIMIT_IP_CANDIDATE_SESSION / _ENTRY / _USER_CANDIDATE /
// RATE_LIMIT_TENANT) and the pg pool (PG_POOL_MAX).
//
// Prerequisites
//   1. A staging/local stack (docker compose up) with a published assessment and
//      >= N invited candidates. Generate one magic-link token per candidate
//      (the token is the last path segment of /take/<token>, >= 16 chars).
//   2. A CSV with ONE token per line (optional header line "token" is skipped).
//      Tokens are single-use-ish per attempt: re-seed between runs.
//   3. Staging must NOT sit behind a per-IP limiter you cannot tune; if you run
//      the k6 box behind a proxy, make sure cf-connecting-ip (or, in non-prod,
//      x-forwarded-for) resolves to ONE value, as it would for a real lab.
//      Against a local NODE_ENV!=production stack this script sends a fixed
//      x-forwarded-for (LAB_IP) so the limiter sees a single lab IP.
//
// Run
//   k6 run \
//     -e BASE_URL=http://localhost:3000 \
//     -e TOKENS_CSV=./tokens.csv \
//     -e CANDIDATES=300 -e DURATION_MIN=10 -e LAB_IP=203.0.113.7 \
//     tools/load/candidate-drive.k6.js
//
// Env
//   BASE_URL      required, e.g. https://staging.example.test (no trailing /)
//   TOKENS_CSV    path to the token CSV (default ./tokens.csv)
//   CANDIDATES    number of virtual candidates (default 300; capped by CSV rows)
//   DURATION_MIN  autosave phase length in minutes (default 10)
//   AUTOSAVE_SEC  autosave period (default 5)
//   LAB_IP        x-forwarded-for sent on every request (default 203.0.113.7)
//
// Pass criteria (thresholds below): no 429s, p95 < 1.5 s, error rate < 1 %.

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "").replace(/\/$/, "");
if (BASE_URL === "") fail("BASE_URL is required (staging/local only)");
if (/assessiq\.(automateedge\.cloud|in)/i.test(BASE_URL) && __ENV.I_AM_SURE_NOT_PROD !== "1") {
  fail("BASE_URL looks like production; refusing. This script is for staging/local only.");
}

const CANDIDATES = parseInt(__ENV.CANDIDATES || "300", 10);
const DURATION_MIN = parseFloat(__ENV.DURATION_MIN || "10");
const AUTOSAVE_SEC = parseFloat(__ENV.AUTOSAVE_SEC || "5");
const LAB_IP = __ENV.LAB_IP || "203.0.113.7";

const tokens = new SharedArray("tokens", () =>
  open(__ENV.TOKENS_CSV || "./tokens.csv")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 16 && l.toLowerCase() !== "token"),
);

const rateLimited = new Counter("rate_limited_429");

export const options = {
  scenarios: {
    lab: {
      executor: "per-vu-iterations",
      vus: Math.min(CANDIDATES, tokens.length || CANDIDATES),
      iterations: 1,
      maxDuration: `${Math.ceil(DURATION_MIN) + 10}m`,
    },
  },
  thresholds: {
    rate_limited_429: ["count==0"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

const headers = {
  "Content-Type": "application/json",
  "x-forwarded-for": LAB_IP, // honoured only when NODE_ENV!=production
};

function track(res) {
  if (res.status === 429) rateLimited.add(1);
  return res;
}

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  // Each VU has its own cookie jar -> its own candidate session.

  // Spread the entry burst a little (a lab does not click in the same ms).
  sleep(Math.random() * 20);

  // 1. Landing preview (anonymous, read-only) then 2. Begin (mints session).
  track(http.post(`${BASE_URL}/take/start`, JSON.stringify({ token, preview: true }), { headers }));
  const start = track(
    http.post(`${BASE_URL}/take/start`, JSON.stringify({ token, consent: true }), { headers }),
  );
  if (!check(start, { "begin 200": (r) => r.status === 200 })) return;
  const attemptId = start.json("attempt_id");

  // 3. Load the attempt (questions + remaining time).
  const view = track(http.get(`${BASE_URL}/api/me/attempts/${attemptId}`, { headers }));
  if (!check(view, { "attempt 200": (r) => r.status === 200 })) return;
  const questions = view.json("questions") || [];
  if (questions.length === 0) fail("attempt has no questions");

  // 4. Autosave loop: one save / AUTOSAVE_SEC, rotating through questions,
  //    growing the answer text like a typist would.
  const endAt = Date.now() + DURATION_MIN * 60 * 1000;
  let revision = 0;
  let i = 0;
  let text = "";
  while (Date.now() < endAt) {
    const q = questions[i % questions.length];
    text += "lorem ipsum dolor sit amet ";
    revision += 1;
    const save = track(
      http.post(
        `${BASE_URL}/api/me/attempts/${attemptId}/answer`,
        JSON.stringify({
          question_id: q.question_id,
          answer: { text },
          client_revision: revision,
          edits_count: revision,
          time_spent_seconds: Math.round(revision * AUTOSAVE_SEC),
        }),
        { headers },
      ),
    );
    check(save, { "autosave ok": (r) => r.status >= 200 && r.status < 300 });
    if (revision % 12 === 0) i += 1; // move to the next question each ~minute
    sleep(AUTOSAVE_SEC);
  }

  // 5. Submit.
  const submit = track(http.post(`${BASE_URL}/api/me/attempts/${attemptId}/submit`, null, { headers }));
  check(submit, { "submit ok": (r) => r.status >= 200 && r.status < 300 });
}
