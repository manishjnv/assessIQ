// Tests for CandidateSessionBanner component.
// Contract: hidden when daysLeft > 5; visible at 5 and 1; hidden at 0 or negative;
// dismiss button hides and persists in localStorage keyed by sessionId.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CandidateSessionBanner } from '../components';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function expiresIn(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString();
}

function expiresAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

const SESSION_ID = 'sess-test-123';
const EMAIL = 'candidate@example.com';
const DISMISS_KEY = `aiq-session-banner-dismissed:${SESSION_ID}`;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CandidateSessionBanner', () => {
  it('is hidden when daysLeft > 5', () => {
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={expiresIn(6)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is hidden when daysLeft > 5 (boundary: exactly 6 days)', () => {
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={expiresIn(6)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is visible at exactly 5 days remaining', () => {
    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(5)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByText(/Your sign-in expires in/)).toBeDefined();
  });

  it('is visible at 1 day remaining and shows singular "day"', () => {
    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(1)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByText(/1 day\./)).toBeDefined();
  });

  it('is hidden when daysLeft is 0 (exactly expired)', () => {
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={new Date(Date.now()).toISOString()}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    // daysLeft = 0 exactly falls below threshold (< 0 check) — hidden.
    expect(container.firstChild).toBeNull();
  });

  it('is hidden when expiresAt is in the past (negative daysLeft)', () => {
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={expiresAgo(1)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is hidden when expiresAt is undefined', () => {
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={undefined}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('dismiss button hides the banner', () => {
    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(3)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByRole('status')).toBeDefined();

    const dismissBtn = screen.getByRole('button', { name: /Dismiss/i });
    fireEvent.click(dismissBtn);

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismiss persists to localStorage keyed by sessionId', () => {
    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(3)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
  });

  it('banner stays hidden on re-render when localStorage key is already set', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    const { container } = render(
      <CandidateSessionBanner
        expiresAt={expiresIn(3)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('"Send me a new link" button calls POST /api/auth/candidate/request-link', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(2)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );

    const renewBtn = screen.getByText('Send me a new link');
    fireEvent.click(renewBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/candidate/request-link',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // After sending, shows confirmation text.
    await waitFor(() => {
      expect(screen.getByText(/A new sign-in link is on its way/)).toBeDefined();
    });
  });

  it('uses plural "days" for counts > 1', () => {
    render(
      <CandidateSessionBanner
        expiresAt={expiresIn(4)}
        email={EMAIL}
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByText(/days\./)).toBeDefined();
  });
});
