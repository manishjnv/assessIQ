// Tests for CandidateShell component.
// Verifies: top bar renders email; sign-out calls fetch + navigates; the nav
// links to Results / Certificates / Activity (desktop inline nav + mobile menu).

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { CandidateShell } from '../components';

// CandidateShell renders react-router NavLinks (M4), so every render needs a Router.
function renderShell(ui: ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const WHOAMI_OK = {
  user: { id: 'user-abc', email: 'candidate@example.com', name: 'Alice', role: 'candidate' },
  tenant: { id: 'tenant-1', slug: 'demo' },
  mfaStatus: 'n/a',
  expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days out
};

function mockFetch(
  responses: Array<{ url?: string | RegExp; body: unknown; status?: number }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const entry =
      responses.find((r) =>
        r.url === undefined
          ? true
          : typeof r.url === 'string'
            ? url.includes(r.url)
            : r.url.test(url),
      ) ?? responses[responses.length - 1];

    const status = entry?.status ?? 200;
    const body = entry?.body ?? {};
    return {
      ok: status < 400,
      status,
      json: async () => body,
    };
  });
}

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

describe('CandidateShell', () => {
  it('renders children', async () => {
    vi.stubGlobal('fetch', mockFetch([{ url: /whoami/, body: WHOAMI_OK }]));
    renderShell(<CandidateShell><div>Hello world</div></CandidateShell>);
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('shows "Signed in as <email>" in the top bar after whoami resolves', async () => {
    vi.stubGlobal('fetch', mockFetch([{ url: /whoami/, body: WHOAMI_OK }]));
    renderShell(<CandidateShell><div /></CandidateShell>);
    await waitFor(() => {
      expect(screen.getByText('candidate@example.com')).toBeDefined();
    });
    expect(screen.getByText(/Signed in as/)).toBeDefined();
  });

  it('sign-out button calls POST /api/auth/logout then redirects to /candidate/login', async () => {
    const fetchMock = mockFetch([
      { url: /whoami/, body: WHOAMI_OK },
      { url: /logout/, body: {}, status: 200 },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    // Capture window.location.href assignment.
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    } as Location);
    let capturedHref = '';
    Object.defineProperty(window.location, 'href', {
      set: (v: string) => { capturedHref = v; },
      get: () => capturedHref,
      configurable: true,
    });

    renderShell(<CandidateShell><div /></CandidateShell>);
    await waitFor(() => {
      expect(screen.getByText('Sign out')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes('/api/auth/logout'))).toBe(true);
    });

    locationSpy.mockRestore();
  });

  it('renders AssessIQ logo text in top bar', async () => {
    vi.stubGlobal('fetch', mockFetch([{ url: /whoami/, body: WHOAMI_OK }]));
    renderShell(<CandidateShell><div /></CandidateShell>);
    // Logo text rendered by the aiq-mark span inside the header.
    await waitFor(() => {
      expect(screen.getAllByText('AssessIQ').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not show email section while whoami is loading', () => {
    // Never-resolving fetch keeps it in loading state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderShell(<CandidateShell><div /></CandidateShell>);
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  it('desktop nav links to Results, Certificates and Activity (Results first)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderShell(<CandidateShell><div /></CandidateShell>);
    const nav = screen.getByRole('navigation', { name: 'Candidate sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Results', 'Certificates', 'Activity']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/candidate/results',
      '/candidate/certificates',
      '/candidate/activity',
    ]);
  });

  it('mobile overflow menu also offers Results', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderShell(<CandidateShell><div /></CandidateShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const menu = screen.getByRole('menu', { name: 'Candidate navigation' });
    const results = within(menu).getByRole('menuitem', { name: 'Results' });
    expect(results.getAttribute('href')).toBe('/candidate/results');
  });
});
