# AssessIQ — Playwright E2E tests (`apps/web/e2e/`)

## Test suites

| File | What it tests | Status |
|---|---|---|
| `admin-workflow.spec.ts` | Full admin→candidate 16-step workflow (pack→questions→assessment→attempt→grade→release→cert→verify) | **Live** (requires test-minter, see below) |
| `cert-prod-safety.spec.ts` | `POST /api/dev/mint-session` must return 404 in production | **Live** (auto-skips when `ENABLE_E2E_TEST_MINTER=true`) |
| `take-error-pages.spec.ts` | `/take/expired`, `/take/error` error pages | Live (no auth required) |
| `take-happy-path.spec.ts` | Candidate magic-link take flow | Skipped `TODO(session-4b)` |
| `take-timer-expiry.spec.ts` | Timer expiry during take | Skipped `TODO(session-4b)` |

---

## E2E test-minter (`ENABLE_E2E_TEST_MINTER`)

`admin-workflow.spec.ts` requires a **dev-only session-minting endpoint** (`POST /api/dev/mint-session`) that bypasses Google SSO + TOTP for E2E tests. This endpoint is **NOT registered** in production — it is conditionally imported at API startup only when `ENABLE_E2E_TEST_MINTER=true` is set.

**Invariant:** `ENABLE_E2E_TEST_MINTER` must be absent (or `"false"`) in the production `.env` at `/srv/assessiq/.env`. The endpoint simply does not exist in production; it returns 404 — not 401/403. Verify with:
```bash
curl -I https://assessiq.automateedge.cloud/api/dev/mint-session
# Expected: 404 Not Found
```

### Env vars required to run admin-workflow.spec.ts

| Variable | Description | Default |
|---|---|---|
| `ENABLE_E2E_TEST_MINTER` | Set to `true` on the **API server** | `false` |
| `PLAYWRIGHT_BASE_URL` | SPA origin (e.g. `http://localhost:5173`) | `http://localhost:5173` |
| `E2E_API_BASE_URL` | API origin (e.g. `http://localhost:3000`) | Derived from `PLAYWRIGHT_BASE_URL` port 3000 |

---

## Running locally

**One-time browser install** (~150 MB download):
```
pnpm --filter @assessiq/web exec playwright install chromium
```

**Run all tests against the local Vite dev server** (started automatically by config):
```
ENABLE_E2E_TEST_MINTER=true \
  pnpm --filter @assessiq/web e2e
```
Note: The API must also be running locally with `ENABLE_E2E_TEST_MINTER=true`:
```
ENABLE_E2E_TEST_MINTER=true pnpm --filter @assessiq/api dev
```

**Run the admin-workflow spec only:**
```
ENABLE_E2E_TEST_MINTER=true \
PLAYWRIGHT_BASE_URL=http://localhost:5173 \
E2E_API_BASE_URL=http://localhost:3000 \
  pnpm --filter @assessiq/web exec playwright test admin-workflow
```

## Running against a staging URL

Set `PLAYWRIGHT_BASE_URL` and `E2E_API_BASE_URL` to target the staging SPA + API. Both the SPA and API origins must be accessible, and `ENABLE_E2E_TEST_MINTER=true` must be set on the API server.
```bash
PLAYWRIGHT_BASE_URL=https://staging.assessiq.example.com \
E2E_API_BASE_URL=https://staging.assessiq.example.com \
  pnpm --filter @assessiq/web exec playwright test admin-workflow
```

**For the existing deployment smoke tests only:**
```
PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm --filter @assessiq/web e2e -- take-error-pages
```

## Running in CI

The `e2e` job in `.github/workflows/ci.yml` runs `admin-workflow.spec.ts` when **GitHub repo variables** `E2E_BASE_URL` and `E2E_API_BASE_URL` are configured. If not set, the job is skipped (not failed). To enable:
1. Set `vars.E2E_BASE_URL` and `vars.E2E_API_BASE_URL` in the repo settings.
2. Ensure `ENABLE_E2E_TEST_MINTER=true` is set on the target server.
3. **Never set `ENABLE_E2E_TEST_MINTER=true` on production.**

## Interpreting failures

On CI failure, Playwright traces + screenshots are uploaded as artifacts (retained 14 days). To view:
1. Download `playwright-traces-<run_id>` from the Actions artifacts tab.
2. Open in Playwright Trace Viewer: `pnpm --filter @assessiq/web exec playwright show-trace <file>.zip`

Common failure causes:
- `[factories] mint-session for ... failed — 404` → API is running but `ENABLE_E2E_TEST_MINTER` is not set to `true` on the server.
- `[factories] ... expected 201, got 422 POOL_TOO_SMALL` → The activate-questions step didn't complete before publishing the assessment. Check step 7.
- `[factories] ... expected 200, got 409 AIG_GRADING_IN_PROGRESS` → A prior run's grading is still in-flight. Wait 60s and retry.
- Steps 12b/12c/12d skipped → Claude is not installed in this environment; grading returned `null` so `wasGraded` stayed `false`. Expected in docker-compose CI without VPS Claude CLI.
- `cert-prod-safety.spec.ts` fails with `expected 404, got 200` → `ENABLE_E2E_TEST_MINTER=true` is set on the target API server. Remove it from the prod `.env`.
- Any `console errors on ...` assertion failure → A JS runtime error occurred in the SPA. Check the Playwright trace.

## Why most session-4b tests are skipped

`take-happy-path.spec.ts` and `take-timer-expiry.spec.ts` are wrapped in
`test.skip` with a `// TODO(session-4b)` annotation. They require:

1. `POST /api/take/start` to mint a real candidate session (deferred to Session 4b).
2. A test fixture providing a real magic-link token in `E2E_CANDIDATE_TOKEN`.

## Adding a new test

1. Create `apps/web/e2e/<name>.spec.ts`.
2. Import only from `@playwright/test` and `./fixtures/factories.js` — never from `@assessiq/*` packages.
3. If the test needs a session, use `factories.mintAdminSession()` or `factories.mintCandidateSession()`.
4. Do not use `test.only`, hardcoded production tokens, or `headless: false`.

