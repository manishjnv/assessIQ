/**
 * Unit tests for the post-submit page (scoring + result release, spec 2026-10-01 §3).
 *   S1  'soon'  - scoring message, polls /result every 5 s, swaps in the released result
 *   S2  'email' - email message immediately, no polling
 *   S3  manual-release tenants say "once {tenant} releases it"
 *   S4  no router state - the first GET /result decides (soon / email / released)
 *   S5  60 s window closes -> email message, polling stops
 *   S6  5xx / network / mid-poll 401 never show the error page
 *   S7  401/403/404 on the FIRST fetch with nothing to show -> /take/error
 *   S8  old server (grading_pending, no result_expectation) -> generic email message
 *
 * Real timers are replaced by vitest fake timers; promises are flushed with
 * advanceTimersByTimeAsync inside act().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { getResult } = vi.hoisted(() => ({ getResult: vi.fn() }));

// Keep the real ResultSummary / CandidateApiError; only the network call is faked.
vi.mock('@assessiq/candidate-ui', async () => {
  const actual = await vi.importActual<typeof import('@assessiq/candidate-ui')>('@assessiq/candidate-ui');
  return { ...actual, getResult: (...a: unknown[]) => getResult(...a) };
});

import { CandidateApiError, AFTER_SUBMIT_TEXT } from '@assessiq/candidate-ui';
import { Submitted } from './Submitted';

const SOON_STATE = {
  attempt_id: 'att1',
  status: 'submitted',
  estimated_grading_seconds: 60,
  result_expectation: 'soon',
  email_masked: 'r***@gmail.com',
  turnaround_text: 'within 72 hours',
};
const EMAIL_STATE = { ...SOON_STATE, estimated_grading_seconds: null, result_expectation: 'email' };

const PENDING_SOON = {
  status: 'pending',
  result_expectation: 'soon',
  email_masked: 'r***@gmail.com',
  turnaround_text: 'within 72 hours',
  tenant_name: 'Acme College',
};
const PENDING_EMAIL = { ...PENDING_SOON, result_expectation: 'email' };

const RELEASED = {
  status: 'released',
  total_earned: 42,
  total_max: 60,
  percent: 70,
  passed: true,
  assessment_name: 'Aptitude Test',
  released_at: '2026-10-01T10:00:00.000Z',
  certificate: { credential_id: 'CERT-1', verify_url: 'https://assessiq.example.com/verify/CERT-1' },
};

const SCORING = 'Scoring your answers… this takes under a minute.';
const EMAIL_72H = 'Your result will be emailed to r***@gmail.com within 72 hours.';

function renderSubmitted(state?: unknown): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/take/attempt/att1/submitted', state }]}>
      <Routes>
        <Route path="/take/attempt/:id/submitted" element={<Submitted />} />
        <Route path="/take/error" element={<div>ERROR PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Flush pending promises and advance fake time by `ms`. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Submitted — scoring + result release', () => {
  it("S1 'soon': polls every 5 s and swaps in the complete result", async () => {
    getResult
      .mockResolvedValueOnce(PENDING_SOON)
      .mockResolvedValueOnce(PENDING_SOON)
      .mockResolvedValueOnce(RELEASED);

    renderSubmitted(SOON_STATE);
    // Instant first paint from the submit response — no network wait.
    expect(screen.getByText(SCORING)).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Scoring your answers' })).toBeTruthy();
    expect(screen.queryByText(/emailed to/)).toBeNull();

    await tick(0);
    expect(getResult).toHaveBeenCalledTimes(1);
    expect(screen.getByText(SCORING)).toBeTruthy();

    await tick(5_000);
    expect(getResult).toHaveBeenCalledTimes(2);
    expect(screen.getByText(SCORING)).toBeTruthy();

    await tick(5_000);
    expect(getResult).toHaveBeenCalledTimes(3);

    // Released: complete result only — total / max (percent), Passed, certificate, email note.
    expect(screen.queryByText(SCORING)).toBeNull();
    expect(screen.getByText('Your result is ready.')).toBeTruthy();
    expect(screen.getByText('Aptitude Test')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).toContain('42 / 60 (70%)');
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.getByRole('link', { name: /View certificate/ }).getAttribute('href')).toBe(
      'https://assessiq.example.com/verify/CERT-1',
    );
    expect(screen.getByText('A copy was emailed to r***@gmail.com.')).toBeTruthy();
    // P1: nothing but the final figures.
    expect(text).not.toMatch(/band|justification|percentile|insight/i);

    // Polling stops once released.
    await tick(60_000);
    expect(getResult).toHaveBeenCalledTimes(3);
  });

  it("S2 'email': shows the email message immediately and does not keep polling", async () => {
    getResult.mockResolvedValue(PENDING_EMAIL);

    renderSubmitted(EMAIL_STATE);
    expect(screen.getByText(EMAIL_72H)).toBeTruthy();
    expect(screen.getByText(AFTER_SUBMIT_TEXT)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull(); // no spinner

    await tick(30_000);
    expect(getResult).toHaveBeenCalledTimes(1); // the single mount check only
    expect(screen.getByText(EMAIL_72H)).toBeTruthy();
  });

  it('S3 manual-release tenants: "once {tenant} releases it"', async () => {
    getResult.mockResolvedValue({ ...PENDING_EMAIL, release_mode: 'manual' });

    renderSubmitted({ ...EMAIL_STATE, release_mode: 'manual' });
    // Before the check: the submit response has no tenant name yet.
    expect(
      screen.getByText('Your result will be emailed to r***@gmail.com once your organisation releases it.'),
    ).toBeTruthy();

    await tick(0);
    expect(
      screen.getByText('Your result will be emailed to r***@gmail.com once Acme College releases it.'),
    ).toBeTruthy();
  });

  it('S4 without router state the first GET /result decides', async () => {
    // soon -> scoring (spinner first while the check is in flight)
    getResult.mockResolvedValue(PENDING_SOON);
    renderSubmitted();
    expect(screen.getByRole('status', { name: 'Loading submission status' })).toBeTruthy();
    await tick(0);
    expect(screen.getByText(SCORING)).toBeTruthy();
    cleanup();

    // email -> email message, no polling
    getResult.mockReset();
    getResult.mockResolvedValue(PENDING_EMAIL);
    renderSubmitted();
    await tick(0);
    expect(screen.getByText(EMAIL_72H)).toBeTruthy();
    await tick(30_000);
    expect(getResult).toHaveBeenCalledTimes(1);
    cleanup();

    // already released (revisit) -> straight to the result; email unknown, so no "copy emailed" line
    getResult.mockReset();
    getResult.mockResolvedValue(RELEASED);
    renderSubmitted();
    await tick(0);
    expect(document.body.textContent).toContain('42 / 60 (70%)');
    expect(screen.queryByText(/A copy was emailed/)).toBeNull();
  });

  it('S5 after the 60 s window it settles on the email message and stops polling', async () => {
    getResult.mockResolvedValue(PENDING_SOON);

    renderSubmitted(SOON_STATE);
    await tick(0);
    await tick(30_000);
    expect(screen.getByText(SCORING)).toBeTruthy();

    await tick(31_000); // now past 60 s
    expect(screen.queryByText(SCORING)).toBeNull();
    expect(screen.getByText(EMAIL_72H)).toBeTruthy();

    const calls = getResult.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(14); // 5 s cadence, 60 s window
    await tick(120_000);
    expect(getResult.mock.calls.length).toBe(calls);
  });

  it('S6 network errors and a mid-poll 401 never show the error page', async () => {
    getResult.mockRejectedValue(new Error('network down'));
    renderSubmitted(SOON_STATE);
    await tick(10_000);
    expect(screen.getByText(SCORING)).toBeTruthy();
    expect(screen.queryByText('ERROR PAGE')).toBeNull();
    await tick(60_000);
    expect(screen.getByText(EMAIL_72H)).toBeTruthy();
    cleanup();

    getResult.mockReset();
    getResult.mockRejectedValue(new CandidateApiError(401, { code: 'UNAUTHENTICATED', message: 'no session' }));
    renderSubmitted(SOON_STATE); // has router state: the candidate just submitted
    await tick(0);
    expect(screen.queryByText('ERROR PAGE')).toBeNull();
    expect(screen.getByText(SCORING)).toBeTruthy();
  });

  it('S7 401/403/404 on the first fetch with nothing to show goes to /take/error', async () => {
    for (const status of [401, 403, 404]) {
      getResult.mockReset();
      getResult.mockRejectedValue(new CandidateApiError(status, { code: `HTTP_${status}`, message: 'nope' }));
      renderSubmitted(); // no router state
      await tick(0);
      expect(screen.getByText('ERROR PAGE')).toBeTruthy();
      cleanup();
    }
  });

  it('S8 an old server (grading_pending, no result_expectation) gets the generic email message', async () => {
    getResult.mockResolvedValue({ status: 'grading_pending', message: 'pending' });
    renderSubmitted({}); // e.g. submit response without the new fields
    await tick(0);
    expect(
      screen.getByText("Your result will be emailed to your registered email address as soon as it's ready."),
    ).toBeTruthy();
    await tick(30_000);
    expect(getResult).toHaveBeenCalledTimes(1);
  });
});
