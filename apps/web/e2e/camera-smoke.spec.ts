// Camera smoke (Z-82): two screens with fake media and mocked network. No backend, no real data.
// 1. Candidate consent screen on /take/<token>: readiness, camera check, consent, agree and decline.
// 2. Camera reviewer page /admin/camera-review: list, open a row, view a photo, mark reviewed.
// Fake camera: Chromium flags below. The API is mocked with page.route (last registered wins).
import { test, expect, type Page, type Request } from '@playwright/test';

const TOKEN = 'tok_0123456789abcdef';
const NOTICE = '2026-10-20.v1';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

const PREVIEW = {
  attempt_id: null,
  resumed: false,
  candidate: { name: 'Asha Rao' },
  assessment: {
    id: 'a1',
    name: 'Aptitude Test',
    duration_seconds: 1800,
    question_count: 20,
    company_name: 'Acme College',
    delivery_mode: 'real',
    camera_required: true,
    camera_notice_version: NOTICE,
  },
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// Mock the candidate API. Returns the start and consent requests seen so far.
async function mockTakeApi(page: Page): Promise<{ starts: Request[]; consents: Request[] }> {
  const starts: Request[] = [];
  const consents: Request[] = [];
  // Registered first = lowest priority: any other /api call gets an empty 204.
  // Match the pathname only: Vite module URLs such as /@fs/.../src/api/x.ts must still load.
  await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/health', (r) => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/take/start', (r) => {
    const body = r.request().postDataJSON() as { preview?: boolean; consent?: boolean };
    if (body.preview === true) return r.fulfill({ json: PREVIEW });
    starts.push(r.request());
    return r.fulfill({ json: { attempt_id: ATTEMPT_ID, assessment: PREVIEW.assessment } });
  });
  await page.route('**/take/camera-consent', (r) => {
    consents.push(r.request());
    return r.fulfill({ json: { ok: true } });
  });
  return { starts, consents };
}

// Top level: launchOptions cannot change inside a describe group (it forces a new worker).
test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test.describe('camera consent screen (fake camera)', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['camera']);
  });

  test('agree: camera check, consent, Allow starts the attempt with agreed + notice version', async ({ page }) => {
    const errors = collectErrors(page);
    const { starts, consents } = await mockTakeApi(page);

    await page.goto(`/take/${TOKEN}`);
    await page.getByRole('button', { name: 'Check camera' }).click();
    await expect(page.getByLabel('Live picture from your camera')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This test uses your camera' })).toBeVisible();

    await page.getByRole('checkbox').check();
    const consentSent = page.waitForRequest((r) => r.url().endsWith('/take/camera-consent') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Allow camera and start' }).click();

    const body = (await consentSent).postDataJSON() as { token: string; decision: string; noticeVersion: string };
    expect(body.decision).toBe('agreed');
    expect(body.noticeVersion).toBe(NOTICE);
    expect(consents).toHaveLength(1);

    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].postDataJSON()).toMatchObject({ token: TOKEN, consent: true });
    expect(errors, 'console errors on the consent screen').toEqual([]);
  });

  test('decline: the test does not start', async ({ page }) => {
    const errors = collectErrors(page);
    const { starts, consents } = await mockTakeApi(page);

    await page.goto(`/take/${TOKEN}`);
    await page.getByRole('button', { name: 'Check camera' }).click();
    await expect(page.getByLabel('Live picture from your camera')).toBeVisible();
    await page.getByRole('checkbox').check();

    const declineSent = page.waitForRequest((r) => r.url().endsWith('/take/camera-consent') && r.method() === 'POST');
    await page.getByRole('button', { name: 'I do not agree, do not start' }).click();

    const body = (await declineSent).postDataJSON() as { decision: string; noticeVersion: string };
    expect(body.decision).toBe('declined');
    expect(body.noticeVersion).toBe(NOTICE);
    await expect(page.getByText('You did not start the test')).toBeVisible();
    expect(consents).toHaveLength(1);
    expect(starts, 'no start call after decline').toHaveLength(0);
    expect(errors, 'console errors on the decline path').toEqual([]);
  });
});

test.describe('camera reviewer page (mocked admin)', () => {
  test('open a flagged attempt, view a photo, mark reviewed', async ({ page }) => {
    const errors = collectErrors(page);
    const ATT = 'att-smoke-1';
    const reviewed: Request[] = [];

    // A real 1x1 JPEG from the browser, so the <img> check proves the bytes decode.
    const jpegB64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      return c.toDataURL('image/jpeg').split(',')[1];
    });
    const jpeg = Buffer.from(jpegB64, 'base64');

    await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.fulfill({ status: 204 }));
    await page.route('**/api/auth/whoami', (r) =>
      r.fulfill({
        json: {
          user: { id: 'u-admin', email: 'admin@test.assessiq', name: 'Test Admin', role: 'admin' },
          tenant: { id: 't-smoke', slug: 'smoke', name: 'Smoke Org' },
          mfaStatus: 'verified',
          totpEnrolled: true,
        },
      }),
    );
    await page.route('**/api/admin/camera/access', (r) => r.fulfill({ json: { reviewer: true } }));
    await page.route(/\/api\/admin\/camera\/flagged/, (r) =>
      r.fulfill({
        json: {
          items: [
            {
              attemptId: ATT,
              userId: 'u-candidate',
              candidateName: 'Ravi Kumar',
              candidateEmail: 'ravi@test.assessiq',
              assessmentId: 'a1',
              assessmentName: 'Aptitude Test',
              flaggedFiles: 1,
              lastFlaggedAt: '2026-10-20T08:00:00.000Z',
              reviewedAt: null,
              appealState: 'none',
              uploadRefused: false,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route(new RegExp(`/api/admin/camera/attempts/${ATT}/files$`), (r) =>
      r.fulfill({
        json: {
          items: [
            { id: 'f-photo-1', kind: 'photo', takenAt: '2026-10-20T08:01:00.000Z', flagged: true, flagReason: 'camera_stopped', sizeBytes: 2048 },
            { id: 'f-video-1', kind: 'video', takenAt: '2026-10-20T08:02:00.000Z', flagged: false, flagReason: null, sizeBytes: 90000 },
          ],
          review: { reviewedAt: null, appealState: 'none', uploadRefused: false },
        },
      }),
    );
    await page.route(/\/api\/admin\/camera\/files\/f-photo-1\/content$/, (r) =>
      r.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }),
    );
    await page.route(new RegExp(`/api/admin/camera/attempts/${ATT}/reviewed$`), (r) => {
      reviewed.push(r.request());
      return r.fulfill({ json: { ok: true } });
    });

    await page.goto('/admin/camera-review');
    await page.getByRole('button', { name: /Ravi Kumar/ }).click();
    await page.getByRole('button', { name: 'View', exact: true }).first().click();

    const img = page.getByRole('img', { name: /Camera photo taken/ });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    const posted = page.waitForRequest((r) => r.url().endsWith(`/attempts/${ATT}/reviewed`) && r.method() === 'POST');
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await posted;
    expect(reviewed).toHaveLength(1);
    await expect(page.getByText(/^Reviewed /).first()).toBeVisible();

    expect(errors, 'console errors on the reviewer page').toEqual([]);
  });
});
