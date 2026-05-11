/**
 * session-mint.test.ts — unit tests for session-mint.ts
 *
 * Verifies:
 *   S1. EMBED_COOKIE_NAME is the frozen value 'aiq_embed_sess'
 *   S2. maxAge = min(jwtExp - now, 8h)  [D6: session hard cap]
 *
 * S2 uses vi.mock to stub sessions.create + withTenant so no DB/Redis needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { EMBED_COOKIE_NAME, mintEmbedSession } from '../session-mint.js';

// ── Mock declarations (hoisted by vitest) ────────────────────────────────────
// Mock ONLY the transitive deps used by mintEmbedSession:
//   @assessiq/auth → sessions.create
//   @assessiq/tenancy → withTenant
vi.mock('@assessiq/auth', () => ({
  sessions: { create: vi.fn() },
}));
vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn(),
}));

// Import the mocked modules AFTER vi.mock declarations so we get the mock instances.
import { sessions } from '@assessiq/auth';
import { withTenant } from '@assessiq/tenancy';

// ── S1 ───────────────────────────────────────────────────────────────────────

describe('EMBED_COOKIE_NAME (D6 frozen contract)', () => {
  it('S1: is exactly "aiq_embed_sess" (frozen — do not change)', () => {
    // This constant is FROZEN per modules/12-embed-sdk/SKILL.md Decision D6.
    // Changing it would silently break the aiq_embed_sess bridge in server.ts.
    expect(EMBED_COOKIE_NAME).toBe('aiq_embed_sess');
  });
});

// ── S2 ───────────────────────────────────────────────────────────────────────

describe('mintEmbedSession — maxAge calculation (S2, D6 cap)', () => {
  /** Fake session token returned by the mocked sessions.create. */
  const FAKE_TOKEN = 'fake-session-token-abcdef';
  /** 8 hours in seconds — the D6 hard cap. */
  const EMBED_MAX_SEC = 8 * 60 * 60;

  beforeEach(() => {
    vi.resetAllMocks();

    // sessions.create: return a minimal CreateSessionOutput
    vi.mocked(sessions.create).mockResolvedValue({
      id: 'fake-session-id-123',
      token: FAKE_TOKEN,
      expiresAt: new Date(Date.now() + EMBED_MAX_SEC * 1000).toISOString(),
    });

    // withTenant: call the callback with a mock PoolClient whose query is a no-op.
    // mintEmbedSession uses this only for: UPDATE sessions SET session_type = 'embed'
    vi.mocked(withTenant).mockImplementation(
      async (_tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        } as unknown as PoolClient;
        return fn(mockClient);
      },
    );
  });

  it('S2a: maxAge = jwtRemaining when jwtRemaining < 8h', async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwtExp = before + 3600; // 1h from now — well under the 8h cap

    const result = await mintEmbedSession({
      userId: 'user-abc',
      tenantId: 'tenant-xyz',
      jwtExp,
      ip: '127.0.0.1',
      ua: 'test-agent/1.0',
    });

    const after = Math.floor(Date.now() / 1000);
    // maxAge must be clamped to jwtRemaining, not the 8h cap.
    // jwtRemaining = jwtExp - now_inside_function, where now_inside_function
    // is between before and after (test execution time).
    const maxExpected = jwtExp - before;          // 3600 or very close
    const minExpected = jwtExp - after;           // 3600 minus elapsed time

    expect(result.token).toBe(FAKE_TOKEN);
    expect(result.maxAge).toBeLessThanOrEqual(maxExpected);
    expect(result.maxAge).toBeGreaterThanOrEqual(Math.max(0, minExpected));
    // Must NOT be the 8h cap (regression guard that min() picks the smaller value).
    expect(result.maxAge).toBeLessThan(EMBED_MAX_SEC);
  });

  it('S2b: maxAge is capped at 8h when jwtRemaining > 8h', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwtExp = now + 100_000; // ~27h — deliberately exceeds 8h cap

    const result = await mintEmbedSession({
      userId: 'user-abc',
      tenantId: 'tenant-xyz',
      jwtExp,
      ip: '127.0.0.1',
      ua: 'test-agent/1.0',
    });

    // maxAge must be exactly the 8h cap, not the full jwtRemaining.
    expect(result.maxAge).toBe(EMBED_MAX_SEC);
    expect(result.token).toBe(FAKE_TOKEN);
  });
});
