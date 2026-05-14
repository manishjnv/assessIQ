// AssessIQ — apps/web/e2e/cert-prod-safety.spec.ts
//
// Prod-safety guard: POST /api/dev/mint-session MUST return 404 when
// ENABLE_E2E_TEST_MINTER is absent or false (i.e. production-like environments).
//
// The endpoint does NOT appear in the production module graph at all — it is a
// conditional dynamic import gated on config.ENABLE_E2E_TEST_MINTER. A 404
// (not a 401/403) confirms the route was never registered.
//
// This spec is SKIPPED automatically when ENABLE_E2E_TEST_MINTER=true so it
// won't trip in docker-compose CI where the minter is intentionally enabled.
//
// Run against prod or a prod-like staging deployment:
//   PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud \
//   E2E_API_BASE_URL=https://assessiq.automateedge.cloud \
//   pnpm --filter @assessiq/web exec playwright test cert-prod-safety

import { test, expect } from '@playwright/test';
import { apiBase } from './fixtures/factories.js';

test.describe('prod-safety — dev-mint-session must not exist in production', () => {
  test.skip(
    process.env['ENABLE_E2E_TEST_MINTER'] === 'true',
    'Skipped when ENABLE_E2E_TEST_MINTER=true (local/CI env with minter enabled)',
  );

  test('POST /api/dev/mint-session returns 404', async () => {
    const res = await fetch(`${apiBase()}/api/dev/mint-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'probe@e2e.test', role: 'candidate', tenantSlug: 'wipro-soc' }),
    });

    expect(
      res.status,
      `Expected 404 from /api/dev/mint-session on ${apiBase()} but got ${res.status}. ` +
        `If this is a staging server, ensure ENABLE_E2E_TEST_MINTER is absent from the API env.`,
    ).toBe(404);
  });
});
