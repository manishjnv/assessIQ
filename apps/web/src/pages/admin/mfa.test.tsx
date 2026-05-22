/**
 * Unit tests for AdminMfa — apps/web/src/pages/admin/mfa.tsx
 *
 * Covers the recovery-code acknowledgement panel that is shown after a
 * successful TOTP enrollment (M1–M5).  All network and router calls are
 * mocked so the tests run in jsdom without a server.
 *
 * Test labels:
 *   M1 — recovery-code panel renders after successful enrollment
 *   M2 — "Continue to dashboard" disabled while acknowledgement checkbox unchecked
 *   M3 — checking the checkbox enables "Continue to dashboard"
 *   M4 — clicking the enabled button calls navigate('/admin', { replace: true })
 *   M5 — "Copy all" calls navigator.clipboard.writeText; button label → 'Copied!'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../lib/api';
import { useSession, fetchWhoami } from '../../lib/session';
import { AdminMfa } from './mfa';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../lib/api');
vi.mock('../../lib/session');
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...(actual as object),
    useNavigate: vi.fn(),
    useLocation: vi.fn(() => ({ pathname: '/admin/mfa' })),
  };
});
vi.mock('qrcode', () => ({
  default: {
    toCanvas: vi.fn(
      (_canvas: unknown, _uri: unknown, _opts: unknown, cb: (err: null) => void) => cb(null),
    ),
  },
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RECOVERY_CODES = [
  'AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD', 'EEEEEEEE',
  'FFFFFFFF', 'GGGGGGGG', 'HHHHHHHH', 'IIIIIIII', 'JJJJJJJJ',
];

let mockNavigate: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Per-test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate = vi.fn();
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);

  vi.mocked(useSession).mockReturnValue({
    session: {
      mfaStatus: 'pending',
      user: { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
      tenant: { id: 't1', slug: 'test' },
    },
    loading: false,
  });

  // First call  → enroll/start response (consumed by the mount-time useEffect).
  // Second call → enroll/confirm response (consumed by the "Confirm and continue" click).
  vi.mocked(api)
    .mockResolvedValueOnce({ otpauthUri: 'otpauth://totp/test', secretBase32: 'JBSWY3DPEHPK3PXP' })
    .mockResolvedValueOnce({ recoveryCodes: RECOVERY_CODES });

  vi.mocked(fetchWhoami).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: bring the component to the recovery-code panel state
// ---------------------------------------------------------------------------

async function reachRecoveryPanel(): Promise<void> {
  render(<AdminMfa />);

  // Wait for the enroll/start API call to resolve — enrolled becomes false,
  // which changes the primary button label from "Verify and continue" to
  // "Confirm and continue".
  await waitFor(() => screen.getByRole('button', { name: /Confirm and continue/i }));

  // Type a 6-digit code. The onChange handler auto-submits the moment the
  // 6th digit is entered — no explicit button click is needed (UX change
  // 2026-05-20: cursor auto-focuses the field; entering 6 digits posts
  // /auth/totp/enroll/confirm immediately). The button still works for
  // accessibility but the test exercises the auto-submit path.
  const input = document.getElementById('totp-code') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '123456' } });

  // Wait for the recovery-code panel to mount (recovery codes returned by the
  // mocked enroll/confirm response).
  await waitFor(() => screen.getByText('Save your recovery codes.'));
}

// ---------------------------------------------------------------------------
// M1 — Recovery-code panel renders after successful enrollment
// ---------------------------------------------------------------------------

describe('AdminMfa recovery-code panel', () => {
  it('M1: renders the "Save your recovery codes." heading and all 10 code strings', async () => {
    await reachRecoveryPanel();

    expect(screen.getByText('Save your recovery codes.')).toBeTruthy();
    for (const code of RECOVERY_CODES) {
      expect(screen.getByText(code)).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // M2 — "Continue to dashboard" disabled while acknowledgement checkbox unchecked
  // ---------------------------------------------------------------------------

  it('M2: "Continue to dashboard" is disabled while the acknowledgement checkbox is unchecked', async () => {
    await reachRecoveryPanel();

    const btn = screen.getByRole('button', {
      name: /Continue to dashboard/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // M3 — Checking the checkbox enables "Continue to dashboard"
  // ---------------------------------------------------------------------------

  it('M3: checking the acknowledgement checkbox enables "Continue to dashboard"', async () => {
    await reachRecoveryPanel();

    fireEvent.click(screen.getByRole('checkbox'));

    const btn = screen.getByRole('button', {
      name: /Continue to dashboard/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // M4 — Clicking the enabled button calls navigate('/admin', { replace: true })
  // ---------------------------------------------------------------------------

  it("M4: clicking the enabled button calls mockNavigate('/admin', { replace: true })", async () => {
    await reachRecoveryPanel();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to dashboard/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
  });

  // ---------------------------------------------------------------------------
  // M5 — "Copy all" calls clipboard.writeText; label changes to 'Copied!'
  // ---------------------------------------------------------------------------

  it("M5: 'Copy all' calls navigator.clipboard.writeText with codes joined by newline, then shows 'Copied!'", async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    await reachRecoveryPanel();

    fireEvent.click(screen.getByText('Copy all'));

    await waitFor(() => screen.getByText('Copied!'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(RECOVERY_CODES.join('\n'));
  });
});
