# AssessIQ — Playwright E2E tests (`apps/web/e2e/`)

## Running locally

**One-time browser install** (~150 MB download):
```
pnpm --filter @assessiq/web exec playwright install chromium
```

**Run against the local Vite dev server** (started automatically by the config):
```
pnpm --filter @assessiq/web e2e
```

## Running against production

Set `PLAYWRIGHT_BASE_URL` to skip the `webServer` block and target the deployed SPA.
To run only the deployment smoke tests (the only suite that is live today):
```
PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm --filter @assessiq/web e2e -- take-error-pages
```

## Why most tests are skipped

`take-happy-path.spec.ts` and `take-timer-expiry.spec.ts` are wrapped in
`test.skip` with a `// TODO(session-4b)` annotation. They require:

1. `POST /api/take/start` to mint a real candidate session (deferred to Session 4b).
2. A test fixture providing a real magic-link token in `E2E_CANDIDATE_TOKEN`.

Only `take-error-pages.spec.ts` runs unconditionally — it verifies the `/take/expired`
and `/take/error` SPA routes and the branded error fallback for an invalid token.

## Adding a new test

1. Create `apps/web/e2e/<name>.spec.ts`.
2. Import only from `@playwright/test` — never from `@assessiq/*` packages.
3. If the test needs a candidate session, guard it with `E2E_CANDIDATE_TOKEN` and
   mark it `test.skip` until Session 4b ships.
4. Do not use `test.only`, hardcoded production tokens, or `headless: false`.
