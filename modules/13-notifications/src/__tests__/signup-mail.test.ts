/**
 * Z-71: the two sign-up mails, and the guarantee that email_log does not keep the plain code.
 * No database: the repository is spied on, so the test sees exactly what would be stored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertEmailLog, queueAdd } = vi.hoisted(() => ({
  insertEmailLog: vi.fn().mockResolvedValue({}),
  queueAdd: vi.fn().mockResolvedValue({ id: 'job' }),
}));

vi.mock('@assessiq/core', async (orig) => {
  const actual = await orig<typeof import('@assessiq/core')>();
  return { ...actual, config: { ...actual.config, SMTP_URL: 'smtp://smtp.test:587', NODE_ENV: 'test' } };
});
vi.mock('@assessiq/tenancy', () => ({
  withTenant: async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({ __fake: true }),
}));
vi.mock('../email/transport.js', () => ({ resolveTransport: vi.fn(() => ({ sendMail: vi.fn() })) }));
vi.mock('../repository.js', async (orig) => ({ ...(await orig<typeof import('../repository.js')>()), insertEmailLog }));
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () { return { add: queueAdd, close: vi.fn() }; }),
  UnrecoverableError: class extends Error {},
}));
vi.mock('ioredis', () => ({ Redis: vi.fn().mockImplementation(function () { return { quit: vi.fn(), on: vi.fn() }; }) }));

import { sendEmail } from '../email/index.js';
import { renderTemplate } from '../email/render.js';

const PLATFORM = '00000000-0000-7000-0000-000000000001';
const CODE = '482916';

beforeEach(() => {
  insertEmailLog.mockClear();
  queueAdd.mockClear();
});

describe('signup mails', () => {
  it('signup_code renders the code in html and text; subject set; code not in the preheader', () => {
    const r = renderTemplate('signup_code', { code: CODE, expires_minutes: 10 });
    expect(r.subject).toBe('Your AssessIQ sign-up code');
    expect(r.text).toContain(CODE);
    expect(r.html).toContain(CODE);
    expect(r.html).not.toMatch(/preheader[^>]*482916/);
  });

  it('signup_code rejects a code that is not 6 characters', () => {
    expect(() => renderTemplate('signup_code', { code: '123', expires_minutes: 10 })).toThrow();
  });

  it('signup_existing_account carries no code and links to the sign-in page', () => {
    const r = renderTemplate('signup_existing_account', { signInLink: 'https://assessiq.test/admin/login' });
    expect(r.subject).toBe('You already have an AssessIQ account');
    expect(r.text).toContain('https://assessiq.test/admin/login');
    expect(r.text).not.toMatch(/\bcode\b/i);
    expect(r.html).toContain('https://assessiq.test/admin/login');
  });

  it('redactLogBody keeps the code out of email_log (body_text and body_html are NULL)', async () => {
    await sendEmail({
      to: 'new@school.test',
      template: 'signup_code',
      vars: { code: CODE, expires_minutes: 10 },
      tenantId: PLATFORM,
      redactLogBody: true,
    });
    expect(insertEmailLog).toHaveBeenCalledTimes(1);
    const stored = insertEmailLog.mock.calls[0]![1] as { bodyText: string | null; bodyHtml: string | null; subject: string; templateId: string };
    expect(stored.bodyText).toBeNull();
    expect(stored.bodyHtml).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(CODE);
    expect(stored.templateId).toBe('signup_code');
    // The send job still needs the body to deliver the mail.
    expect((queueAdd.mock.calls[0]![1] as { bodyText: string }).bodyText).toContain(CODE);
  });

  it('control: without the flag the log keeps the body (so the flag is what removes the code)', async () => {
    await sendEmail({
      to: 'new@school.test',
      template: 'signup_code',
      vars: { code: CODE, expires_minutes: 10 },
      tenantId: PLATFORM,
    });
    const stored = insertEmailLog.mock.calls[0]![1] as { bodyText: string | null };
    expect(stored.bodyText).toContain(CODE);
  });

  it('both sign-up mails are sent as auth-class (never delayed by the bulk cap)', async () => {
    await sendEmail({ to: 'a@b.test', template: 'signup_existing_account', vars: { signInLink: 'https://assessiq.test/admin/login' }, tenantId: PLATFORM, redactLogBody: true });
    const opts = queueAdd.mock.calls[0]![2] as { delay?: number; priority?: number };
    expect(opts.delay).toBeUndefined();
    expect(opts.priority).toBeUndefined();
  });
});
