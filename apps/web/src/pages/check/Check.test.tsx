/**
 * Z-154: /check runs the device checks with no token, no camera and no Begin button.
 * The readiness signals are stubbed so the result is the same on every machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({
  signals: vi.fn(),
}));

vi.mock('../take/readiness.js', async (orig) => {
  const real = await orig<typeof import('../take/readiness.js')>();
  return {
    ...real,
    collectDeviceSignals: () => ({ coarsePointerOnly: false, maxTouchPoints: 0, screenWidth: 1920 }),
    collectReadinessSignals: () => h.signals(),
  };
});

import { CheckPage } from './Check';

const GOOD = {
  browser: { name: 'chrome', version: '124' },
  screenWidth: 1920,
  screenHeight: 1080,
  downlinkMbps: 10,
  rttMs: 50,
};

function renderCheck(): void {
  render(
    <MemoryRouter initialEntries={['/check']}>
      <CheckPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.signals.mockResolvedValue(GOOD);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CheckPage (/check)', () => {
  it('shows the result list and "Your device is ready." with no Begin button and no camera row', async () => {
    renderCheck();
    expect(await screen.findByText('Your device is ready.')).toBeTruthy();
    expect(screen.getByText('Screen size')).toBeTruthy();
    expect(screen.getAllByText('Pass').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /begin/i })).toBeNull();
    expect(screen.queryByText('Camera')).toBeNull();
  });

  it('keeps the failed item and its fix text on the page when the screen is too small', async () => {
    h.signals.mockResolvedValue({ ...GOOD, screenWidth: 800 });
    renderCheck();
    await waitFor(() => expect(screen.getByText('Fix needed')).toBeTruthy());
    expect(screen.getByText(/Your screen is too small/)).toBeTruthy();
    expect(screen.queryByText('Your device is ready.')).toBeNull();
  });
});
