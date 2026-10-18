/**
 * Unit tests for AdminEmailOtp — apps/web/src/pages/admin/email-otp.tsx
 *   E1 — a correct code signs in on the 6th digit (no Verify click) and goes to redirectTo
 *   E2 — a wrong code shows the one fixed message, whatever the server reason
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../../lib/api';
import { AdminEmailOtp } from './email-otp';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<object>('../../lib/api');
  return { ...actual, api: vi.fn() };
});

const MSG = 'That code is not right. Check it and try again.';

async function toCodeStep(): Promise<HTMLInputElement> {
  render(<MemoryRouter><AdminEmailOtp /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'a@b.co' } });
  fireEvent.click(screen.getByRole('button', { name: /send sign-in code/i }));
  return (await screen.findByLabelText(/6-digit sign-in code/i)) as HTMLInputElement;
}

describe('AdminEmailOtp', () => {
  const loc = window.location;
  beforeEach(() => {
    vi.mocked(api).mockReset();
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { value: loc, writable: true });
  });

  it('E1 correct code signs in on the 6th digit and goes to the dashboard', async () => {
    vi.mocked(api).mockResolvedValueOnce({}).mockResolvedValueOnce({ ok: true, redirectTo: '/admin' });
    const input = await toCodeStep();
    fireEvent.change(input, { target: { value: '123456' } });
    await waitFor(() => expect(window.location.href).toBe('/admin'));
    expect(vi.mocked(api).mock.calls[1]![0]).toBe('/auth/login/email/verify');
  });

  it('E2 wrong code shows the one fixed message', async () => {
    vi.mocked(api).mockResolvedValueOnce({}).mockResolvedValueOnce({ ok: false, error: 'invalid_code' });
    const input = await toCodeStep();
    fireEvent.change(input, { target: { value: '000000' } });
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(window.location.href).toBe('');
  });
});
