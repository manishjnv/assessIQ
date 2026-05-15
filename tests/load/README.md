# AssessIQ — Load-test harness

## Overview

k6-based load testing for the AssessIQ API. This directory contains:

- `scenarios/smoke.js` — 5-scenario smoke baseline (run first, ~30s)
- `scenarios/auth-flow.js` — isolated rate-limit boundary probe (run standalone)
- `lib/auth.js` — session-acquisition helpers (dev-mint + cookie-env fallback)
- `results/` — gitignored run outputs; only `.gitkeep` is tracked

**Scope: local dev environment only.** The harness refuses to run against
production URLs (see [Safety](#safety)).

---

## Prerequisites

### 1. Install k6

```
# Windows (winget)
winget install k6 --id k6.k6

# Windows (Chocolatey)
choco install k6

# Verify
k6 version
```

### 2. Dev API must be running

```
# From repo root — starts Fastify on http://localhost:3000
ENABLE_E2E_TEST_MINTER=true pnpm --filter @assessiq/api dev
```

Confirm it's up:
```
curl http://localhost:3000/api/health
# Expected: {"status":"ok"}
```

The `ENABLE_E2E_TEST_MINTER=true` flag is **required** so `lib/auth.js` can
mint test sessions via `POST /api/dev/mint-session`. Without it, scenarios
S3, S4, and S5 (authenticated paths) skip gracefully instead of running.

### 3. Dev DB must be seeded

The mint route uses the **existing** DB role for known emails. Seed these two
users in the `wipro-soc` dev tenant before running:

| Email | Role |
|---|---|
| `loadtest-admin@wipro-soc.test` | `admin` |
| `loadtest-candidate@wipro-soc.test` | `candidate` |

The candidate user is auto-created on first mint (mint route creates unknown
emails with `role=candidate`). The admin user must be seeded manually — the
mint route does NOT create admin users on first call.

**Manual cookie fallback (if dev-mint isn't available):**
```
# Get a real session cookie from the dev browser, then:
LOAD_TEST_ADMIN_COOKIE=<value> \
LOAD_TEST_CANDIDATE_COOKIE=<value> \
  k6 run tests/load/scenarios/smoke.js
```

---

## Running the smoke baseline

```
k6 run tests/load/scenarios/smoke.js
```

Or with an explicit target (defaults to `http://localhost:3000`):
```
TARGET_URL=http://localhost:3000 k6 run tests/load/scenarios/smoke.js
```

Save output to a results file:
```
k6 run tests/load/scenarios/smoke.js 2>&1 | tee tests/load/results/smoke-$(date +%Y%m%dT%H%M%S).txt
```

Run the rate-limit boundary probe standalone (do NOT run alongside smoke.js —
they share the anonymous IP bucket):
```
k6 run tests/load/scenarios/auth-flow.js
```

---

## Interpreting output

k6 prints a summary table after the run. Key columns:

| Metric | Meaning |
|---|---|
| `http_req_duration` | End-to-end request latency (DNS + connect + TLS + send + wait + receive) |
| `http_req_failed` | Rate of non-2xx responses (or network errors); **429 counts as failed** |
| `http_reqs` | Total requests sent |
| `iterations` | VU iterations completed |
| `checks` | Pass rate for inline `check()` assertions |

**Per-scenario metrics** are tagged `{scenario:<name>}`. The threshold block
in `smoke.js` uses these tags so a high error rate in S1 (health-liveness,
intentional 429s) does not fail thresholds for S3–S5.

Full k6 metrics reference: https://k6.io/docs/using-k6/metrics/

### Expected pattern for each scenario

| Scenario | Expected error rate | Notes |
|---|---|---|
| `health-liveness` (S1) | ~70–90% errors (429) | **Intentional.** 10 VUs with no sleep exceeds the 30 req/min anonymous IP bucket. This confirms the rate-limiter is wired correctly. |
| `magic-link-request` (S2) | 50–80% errors (429) | Anonymous bucket shared with S1; requests that get through return 204 in ~200ms (server-side anti-enumeration floor). |
| `admin-whoami` (S3) | <5% errors | Redis session lookup; expect p95 < 50ms on a warm cache. |
| `admin-user-list` (S4) | <5% errors | Postgres + RLS read; expect p95 < 100ms on local Postgres. |
| `candidate-assessments` (S5) | <5% errors | Candidate hot path; expect p95 < 100ms. |

---

## Thresholds

The thresholds in `smoke.js` are **smoke-test gates, not SLOs**. They are
intentionally loose:

```
p(95) < 500ms  — not "our API is fast at 500ms"; it is "the API is not broken"
```

Tighten thresholds only after a real prod load test establishes a stable
baseline. Promote to SLOs only after monitoring panels (Grafana/Sentry) exist.

---

## Safety

`lib/auth.js` contains a hard assertion run at `setup()` time:

```js
// Refuses to run if TARGET_URL matches any production hostname
assertDevOnly(TARGET_URL);
```

Patterns that cause an immediate abort:
- `assessiq.automateedge.cloud`
- `.automateedge.` (catches all automateedge subdomains)
- Any `https://` URL that isn't `localhost` or `127.0.0.1`

**Never schedule this harness against prod in CI without:**
1. A dedicated, pre-allocated maintenance window
2. Explicit user + ops approval (rate-limit buckets reset slowly)
3. Monitoring panels watching p95 + error rate in real time
4. A kill switch: `k6 send-signal ABORT` or Ctrl-C

Prod load tests are a **separate session** — see the next section.

---

## When to run real prod load tests

Not yet. Prerequisites before any prod load test:
1. Sentry DSN wired + error alerting live (ops maturity gap H-3)
2. Grafana panels for rate-limit buckets, Postgres connections, Redis memory
3. Maintenance window scheduled outside business hours
4. A prior smoke run on staging (not just local dev)

Track this as a follow-up session: "schedule prod load test off-hours after
monitoring panels exist for rate-limit buckets."

---

## Adding a new scenario

1. Add a new file under `scenarios/` or a new executor block in `smoke.js`.
2. Follow the `group()` / `exec` naming convention so tags propagate correctly.
3. Add per-scenario thresholds in the `thresholds` block.
4. If it needs auth, add a helper to `lib/auth.js` and call it in `setup()`.
5. Document expected behavior in this README under "Expected pattern."

---

## Results

Output files are written to `tests/load/results/` (gitignored). Only the
`.gitkeep` is committed so the directory exists on clone.

```
tests/load/results/smoke-20260515T093000.txt   ← gitignored
tests/load/results/.gitkeep                    ← committed
```

---

## Baseline (2026-05-15)

*Blocked: dev API was not running at harness-creation time.*

Run the smoke test against a live local dev environment and paste the k6
summary output here:

```
TODO: paste k6 run output after running against local dev
```

| Scenario | p50 | p95 | p99 | RPS | Error rate | Interpretation |
|---|---|---|---|---|---|---|
| health-liveness (S1) | — | — | — | — | — | — |
| magic-link-request (S2) | — | — | — | — | — | — |
| admin-whoami (S3) | — | — | — | — | — | — |
| admin-user-list (S4) | — | — | — | — | — | — |
| candidate-assessments (S5) | — | — | — | — | — | — |
