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
const takeCameraConsent = vi.fn();
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
    AFTER_SUBMIT_TEXT: 'Your answers are saved. You will see your result on this page or by email once it is final.',
    takePreview: (...a: unknown[]) => takePreview(...a),
    takeStart: (...a: unknown[]) => takeStart(...a),
    takeCameraConsent: (...a: unknown[]) => takeCameraConsent(...a),
    CandidateApiError,
    CandidateHelp: () => null,
  };
});

import { CandidateApiError } from '@assessiq/candidate-ui';
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
  screen.getByRole('button', { name: /Begin|Starting|Resume assessment/i }) as HTMLButtonElement;

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

  it('L7 - device-check disclosure is closed by default', async () => {
    renderLanding();
    await screen.findByText('Ready when you are.');
    // The system check runs in an effect after mount: wait until all five rows pass,
    // otherwise `blocked` is still true (rows empty) and the disclosure is open.
    await waitFor(() => expect(screen.getAllByText('OK').length).toBe(5));
    const details = document.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText('Test your device (optional)')).toBeTruthy();
  });

  it('L7b - device-check disclosure opens when blocked', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderLanding();
    await screen.findByText('Ready when you are.');
    await screen.findByText('Fix needed');
    const details = document.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText('Test your device')).toBeTruthy();
    spy.mockRestore();
  });

  it('L8 - Begin label contains the timer minutes', async () => {
    renderLanding();
    await screen.findByText('Ready when you are.');
    expect(beginBtn().textContent).toMatch(/Begin — your \d+-minute timer starts/);
  });

  it('L9 - failed check opens the disclosure, shows the reason and disables Begin', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderLanding();
    await screen.findByText('Ready when you are.');
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByText(/Your device is not ready/);
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText('Test your device')).toBeTruthy();
    expect(beginBtn().disabled).toBe(true);
    spy.mockRestore();
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

  it('Logo L3a - shows the tenant logo when company_logo_url is set', async () => {
    takePreview.mockResolvedValue({
      ...PREVIEW,
      assessment: { ...PREVIEW.assessment, company_logo_url: '/api/public/tenant-logo/t1?v=abc' },
    });
    renderLanding();
    await screen.findByText('Ready when you are.');
    const img = screen.getByAltText('Acme College logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/public/tenant-logo/t1?v=abc');
    expect(screen.queryByText('via AssessIQ')).toBeNull();
    expect(document.title).toBe('Acme College · AssessIQ');
  });

  it('Logo L3a - name only when the logo is null or the field is absent (older server)', async () => {
    takePreview.mockResolvedValue({
      ...PREVIEW,
      assessment: { ...PREVIEW.assessment, company_logo_url: null },
    });
    renderLanding();
    await screen.findByText('Ready when you are.');
    expect(screen.queryByAltText('Acme College logo')).toBeNull();
    expect(screen.queryByText('via AssessIQ')).toBeNull();
    cleanup();
    takePreview.mockResolvedValue(PREVIEW);
    renderLanding();
    await screen.findByText('Ready when you are.');
    expect(screen.queryByRole('img', { name: /logo/i })).toBeNull();
  });
});

// Z-87 / Z-89 / Z-91: the page shows the right screen for each test type; the server still enforces.
describe('TokenLanding test type (Z-87, Z-89, Z-91)', () => {
  const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const withMode = (mode: 'real' | 'mock') => ({
    ...PREVIEW,
    assessment: { ...PREVIEW.assessment, delivery_mode: mode },
  });
  const useDevice = (ua: string, width: number): void => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    vi.stubGlobal('screen', { width, height: width > 900 ? 1080 : 800 });
  };

  it('real exam on a phone: the plain message replaces Begin', async () => {
    useDevice(IPHONE_UA, 390);
    takePreview.mockResolvedValue(withMode('real'));
    renderLanding();
    await screen.findByText('Please open this link on a laptop or desktop computer to take this test');
    expect(screen.queryByRole('button', { name: /Begin/i })).toBeNull();
    expect(takeStart).not.toHaveBeenCalled();
  });

  it('real exam on a desktop: Begin waits for the readiness check, then sends the signals', async () => {
    useDevice(DESKTOP_UA, 1920);
    takePreview.mockResolvedValue(withMode('real'));
    renderLanding();
    await screen.findByText('Readiness check');
    await waitFor(() => expect(screen.getAllByText('Pass').length).toBe(4));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(beginBtn().disabled).toBe(false);
    fireEvent.click(beginBtn());
    await screen.findByText('ATTEMPT PAGE');
    const body = takeStart.mock.calls[0]![1] as { readiness: { screenWidth: number; browser: { name: string } } };
    expect(body.readiness.screenWidth).toBe(1920);
    expect(body.readiness.browser.name).toBe('chrome');
  });

  it('real exam on a small screen: readiness fails and Begin stays disabled', async () => {
    useDevice(DESKTOP_UA, 1000);
    takePreview.mockResolvedValue(withMode('real'));
    renderLanding();
    await screen.findByText(/Your screen is too small/);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(beginBtn().disabled).toBe(true);
  });

  it('mock test: labelled Mock, readiness is an optional rehearsal that never blocks Begin', async () => {
    useDevice(IPHONE_UA, 390);
    takePreview.mockResolvedValue(withMode('mock'));
    renderLanding();
    await screen.findByText('Mock test');
    await screen.findByText('Dress rehearsal (optional)');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(beginBtn().disabled).toBe(false);
  });

  it('server answer DEVICE_NOT_ALLOWED shows the same plain message', async () => {
    useDevice(DESKTOP_UA, 1920);
    takePreview.mockResolvedValue(withMode('real'));
    const { CandidateApiError } = await import('@assessiq/candidate-ui');
    takeStart.mockRejectedValue(new CandidateApiError(403, { code: 'DEVICE_NOT_ALLOWED', message: 'x' }));
    renderLanding();
    await waitFor(() => expect(screen.getAllByText('Pass').length).toBe(4));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(beginBtn());
    await screen.findByRole('alert');
    expect(screen.getAllByText('Please open this link on a laptop or desktop computer to take this test').length).toBeGreaterThan(0);
  });
});

// Z-82: a real exam with camera_required. Camera check, consent screen, Allow and Decline.
describe('TokenLanding camera consent (Z-82)', () => {
  const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const CAMERA_PREVIEW = {
    ...PREVIEW,
    assessment: {
      ...PREVIEW.assessment,
      delivery_mode: 'real',
      camera_required: true,
      camera_notice_version: '2026-10-20.v1',
    },
  };
  const TOKEN = 'tok_0123456789abcdef';
  const stop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop }] };
  const getUserMedia = vi.fn();
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP_UA);
    vi.stubGlobal('screen', { width: 1920, height: 1080 });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    getUserMedia.mockResolvedValue(fakeStream);
    takeCameraConsent.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  const checkCamera = async (): Promise<void> => {
    await waitFor(() => expect(screen.getAllByText('Pass').length).toBe(4));
    fireEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    await screen.findByText('This test uses your camera');
  };

  it('the camera row is hidden for a mock test and for a real test without camera_required', async () => {
    takePreview.mockResolvedValue({
      ...PREVIEW,
      assessment: { ...PREVIEW.assessment, delivery_mode: 'mock', camera_required: true },
    });
    renderLanding();
    await screen.findByText('Dress rehearsal (optional)');
    expect(screen.queryByRole('button', { name: 'Check camera' })).toBeNull();
    cleanup();
    takePreview.mockResolvedValue({ ...PREVIEW, assessment: { ...PREVIEW.assessment, delivery_mode: 'real' } });
    renderLanding();
    await screen.findByText('Readiness check');
    expect(screen.queryByRole('button', { name: 'Check camera' })).toBeNull();
  });

  it('a passing camera check shows the live picture and then the consent screen', async () => {
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await screen.findByText('Readiness check');
    await waitFor(() => expect(screen.getAllByText('Pass').length).toBe(4));
    expect(screen.queryByText('This test uses your camera')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    await screen.findByText('This test uses your camera');
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(screen.getByLabelText('Live picture from your camera')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('a denied camera shows the plain message and keeps the consent screen closed', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await waitFor(() => expect(screen.getAllByText('Pass').length).toBe(4));
    fireEvent.click(screen.getByRole('button', { name: 'Check camera' }));
    await screen.findByText(
      'Camera access is blocked. Allow the camera in your browser settings, then press Retry.',
    );
    expect(screen.queryByText('This test uses your camera')).toBeNull();
  });

  it('Allow records the agreed consent, then starts the test and stops the camera', async () => {
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await checkCamera();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow camera and start' }));
    await screen.findByText('ATTEMPT PAGE');
    expect(takeCameraConsent).toHaveBeenCalledWith(TOKEN, 'agreed', '2026-10-20.v1');
    expect(takeStart).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ consent: true, device: expect.anything(), readiness: expect.anything() }),
    );
    expect(takeCameraConsent.mock.invocationCallOrder[0]!).toBeLessThan(takeStart.mock.invocationCallOrder[0]!);
    expect(stop).toHaveBeenCalled();
  });

  it('Decline records the decision, shows the message and never starts the test', async () => {
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await checkCamera();
    fireEvent.click(screen.getByRole('button', { name: 'I do not agree, do not start' }));
    await screen.findByText(/You did not start the test/);
    expect(takeCameraConsent).toHaveBeenCalledWith(TOKEN, 'declined', '2026-10-20.v1');
    expect(takeStart).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Allow camera and start' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to the start' })).toBeTruthy();
  });

  it('a stale notice on Allow reloads the preview', async () => {
    takeCameraConsent.mockRejectedValue(
      new CandidateApiError(422, { code: 'CAMERA_NOTICE_STALE', message: 'stale' }),
    );
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await checkCamera();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow camera and start' }));
    await waitFor(() => expect(takePreview).toHaveBeenCalledTimes(2));
    expect(takeStart).not.toHaveBeenCalled();
  });

  it('the server set-up refusal shows its message on Allow', async () => {
    takeStart.mockRejectedValue(
      new CandidateApiError(422, {
        code: 'CAMERA_SETUP_REQUIRED',
        message: 'The test organiser has not finished the camera set-up. Contact your test organiser.',
      }),
    );
    takePreview.mockResolvedValue(CAMERA_PREVIEW);
    renderLanding();
    await checkCamera();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow camera and start' }));
    await screen.findByText(/has not finished the camera set-up/);
    // Begin stopped the camera, so the candidate checks it again before the consent screen returns.
    expect(screen.getByRole('button', { name: 'Check camera' })).toBeTruthy();
  });
});
