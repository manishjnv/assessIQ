/**
 * modules/13-notifications/src/__tests__/candidate-login-link.test.ts
 *
 * Smoke test for the candidate_login_link email template.
 *
 * Asserts:
 *   a) renderTemplate returns without throwing for valid vars.
 *   b) HTML output contains all three substituted values.
 *   c) Text output contains all three substituted values.
 *   d) Neither output contains raw {{ placeholder syntax.
 *   e) Subject line is extracted correctly from the txt template.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they are available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

// ---------------------------------------------------------------------------
// Module mocks — must appear before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@assessiq/core', () => ({
  config: {
    NODE_ENV: 'test',
    SMTP_URL: '',
    EMAIL_FROM: 'AssessIQ <noreply@test.assessiq.com>',
    REDIS_URL: 'redis://localhost:6379',
    ASSESSIQ_BASE_URL: 'https://assessiq.test',
    ASSESSIQ_MASTER_KEY: Buffer.alloc(32).toString('base64'),
    LOG_DIR: undefined,
    LOG_LEVEL: 'error',
    SESSION_SECRET: Buffer.alloc(32).toString('base64'),
    SESSION_COOKIE_NAME: 'aiq_sess',
    EMBED_JWT_SECRET_PROVISION_MODE: 'per-tenant',
    MFA_REQUIRED: false,
    AI_PIPELINE_MODE: 'claude-code-vps',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
  streamLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

// ---------------------------------------------------------------------------
// Test vars
// ---------------------------------------------------------------------------

const TEST_VARS = {
  display_name: 'Test',
  link_url: 'https://example.com/x',
  expires_minutes: 15,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('candidate_login_link email template', () => {
  it('renders HTML and text without throwing', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const result = renderTemplate('candidate_login_link', TEST_VARS);

    expect(result).toBeDefined();
    expect(typeof result.html).toBe('string');
    expect(typeof result.text).toBe('string');
    expect(typeof result.subject).toBe('string');
  });

  it('HTML output contains all three substituted values', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { html } = renderTemplate('candidate_login_link', TEST_VARS);

    expect(html).toContain('Test');
    expect(html).toContain('https://example.com/x');
    expect(html).toContain('15');
  });

  it('text output contains all three substituted values', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { text } = renderTemplate('candidate_login_link', TEST_VARS);

    expect(text).toContain('Test');
    expect(text).toContain('https://example.com/x');
    expect(text).toContain('15');
  });

  it('HTML output does not contain raw {{ placeholder syntax', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { html } = renderTemplate('candidate_login_link', TEST_VARS);

    expect(html).not.toMatch(/\{\{/);
  });

  it('text output does not contain raw {{ placeholder syntax', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { text } = renderTemplate('candidate_login_link', TEST_VARS);

    expect(text).not.toMatch(/\{\{/);
  });

  it('subject line is extracted from the txt Subject: header', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { subject } = renderTemplate('candidate_login_link', TEST_VARS);

    expect(subject).toBe('Your AssessIQ sign-in link');
  });

  it('throws ZodError for missing required vars', async () => {
    const { renderTemplate } = await import('../email/render.js');

    expect(() =>
      renderTemplate('candidate_login_link', {
        display_name: 'Test',
        // link_url and expires_minutes intentionally omitted
      }),
    ).toThrow();
  });
});
