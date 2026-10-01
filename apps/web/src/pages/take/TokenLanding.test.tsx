/**
 * Unit tests for the /take/:token pre-test screen (R4).
 *   L1 - opening the landing only calls takePreview (no takeStart = no clock)
 *   L2 - Begin disabled until consent is ticked; then Begin calls takeStart({consent:true})
 *   L3 - server-unreachable / storage failures only warn (Begin enabled); offline blocks Begin
 *   L4 - practice question is selectable and never submitted
 *   L5 - resumed attempt skips consent and resumes without consent flag
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const takePreview = vi.fn();
const takeStart = vi.fn();
vi.mock('@assessiq/candidate-ui', () => {
  class CandidateApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  }
  return {
    takePreview: (...a: unknown[]) => takePreview(...a),
    takeStart: (...a: unknown[]) => takeStart(...a),
    CandidateApiError,
    CandidateHelp: () => null,
  };
});

import { TokenLanding } from './TokenLanding';

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
  },
};

function renderLanding(): void {
  render(
    <MemoryRouter initialEntries={['/take/tok_0123456789abcdef']}>
      <Routes>
        <Route path="/take/:token" element={<TokenLanding />} />
        <Route path="/take/attempt/:id" element={<div>ATTEMPT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const beginBtn = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Begin assessment|Starting|Resume assessment/i }) as HTMLButtonElement;

beforeEach(() => {
  takePreview.mockResolvedValue(PREVIEW);
  takeStart.mockResolvedValue({ attempt_id: 'att1', assessment: PREVIEW.assessment });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('TokenLanding pre-test screen', () => {
  it('L1 - opening the link only previews; it never starts the attempt', async () => {
    renderLanding();
    await screen.findByText('Ready when you are.');
    expect(takePreview).toHaveBeenCalledTimes(1);
    expect(takeStart).not.toHaveBeenCalled();
    expect(screen.getByText(/Acme College · 30 min · 20 questions/)).toBeTruthy();
  });

  it('L2 - Begin is disabled until consent; then it starts with consent', async () => {
    renderLanding();
    await screen.findByText('Ready when you are.');
    await waitFor(() => expect(screen.getAllByText('OK').length).toBe(5));
    expect(beginBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(beginBtn().disabled).toBe(false);
    fireEvent.click(beginBtn());
    await screen.findByText('ATTEMPT PAGE');
    expect(takeStart).toHaveBeenCalledWith('tok_0123456789abcdef', { consent: true });
  });

  it('L3 - server unreachable is a warning only: Begin stays enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    renderLanding();
    await screen.findByText('Ready when you are.');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByText(/could not reach AssessIQ/i);
    expect(screen.queryByText('Fix needed')).toBeNull();
    expect(beginBtn().disabled).toBe(false);
  });

  it('L3b - storage failure is a warning only: Begin stays enabled', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderLanding();
    await screen.findByText('Ready when you are.');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByText(/Turn on cookies/i);
    expect(beginBtn().disabled).toBe(false);
    spy.mockRestore();
  });

  it('L3c - offline blocks Begin even with consent', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderLanding();
    await screen.findByText('Ready when you are.');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByText('Fix needed');
    expect(beginBtn().disabled).toBe(true);
    spy.mockRestore();
  });

  it('L4 - practice question is selectable and never submitted', async () => {
    renderLanding();
    await screen.findByText('What is 15% of 200?');
    expect(screen.getByText('Practice — not scored')).toBeTruthy();
    const opt = screen.getByLabelText(/30/) as HTMLInputElement;
    fireEvent.click(opt);
    expect(opt.checked).toBe(true);
    expect(takeStart).not.toHaveBeenCalled();
  });

  it('L5 - resumed attempt: no consent needed, resumes without consent flag', async () => {
    takePreview.mockResolvedValue({ ...PREVIEW, attempt_id: 'att1', resumed: true });
    renderLanding();
    await screen.findByText('Pick up where you left off.');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(beginBtn());
    await screen.findByText('ATTEMPT PAGE');
    expect(takeStart).toHaveBeenCalledWith('tok_0123456789abcdef', { consent: false });
  });

  it('L6 - an expired or replaced link (404) says so and tells the student to ask for a resend', async () => {
    const { CandidateApiError } = (await import('@assessiq/candidate-ui')) as unknown as {
      CandidateApiError: new (status: number, e: { code: string; message: string }) => Error;
    };
    takePreview.mockRejectedValue(
      new CandidateApiError(404, { code: 'INVITATION_NOT_FOUND', message: 'not found' }),
    );
    renderLanding();
    await screen.findByText("We couldn't open this link.");
    expect(screen.getByText(/may have expired/i)).toBeTruthy();
    expect(screen.getByText(/replaced it/i)).toBeTruthy();
    expect(screen.getByText(/ask the person who\s+invited you to resend your invitation/i)).toBeTruthy();
  });
});
