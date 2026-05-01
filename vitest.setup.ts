/**
 * Vitest global setup — runs before any test module loads.
 *
 * Purpose: provide deterministic env fixtures so the eager `config` singleton
 * in `modules/00-core/src/config.ts` (line `export const config = loadConfig()`)
 * does not throw when transitive imports (e.g. logger.ts importing config) load
 * before any test code runs.
 *
 * Tests that need to drive `loadConfig()` with custom inputs use the function
 * form (`loadConfig({...})`) directly and ignore these fixtures.
 *
 * `??=` ensures we never override a value the developer or CI explicitly set.
 */

const BASE64_32_BYTES = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero-bytes

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/aiq_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.ASSESSIQ_MASTER_KEY ??= BASE64_32_BYTES;
process.env.SESSION_SECRET ??= BASE64_32_BYTES;

// Google SSO test fixtures — safe placeholders so config validation passes when
// the real credentials are not set in the environment. Tests that actually call
// Google endpoints mock fetch() and are not affected by these values.
process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT ??= "https://assessiq.automateedge.cloud/api/auth/google/cb";
