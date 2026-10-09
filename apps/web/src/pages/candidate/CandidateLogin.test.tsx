/**
 * Unit tests for CandidateLogin.
 *   - Phase D state-aware revocation banner (candidate audience). Same
 *     single-shot `aiq.lastAuthScope` mechanism as the admin login, with calmer
 *     assessment-facing copy.
 *   - Tenant (organisation) comes from `?tenant=` — the old hard-coded
 *     'wipro-soc' is gone; without the param the candidate types an
 *     "Organisation code".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CandidateLogin } from './CandidateLogin';

const { apiMock, nav } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  nav: { search: '' },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...(actual as object),
    useSearchParams: () => [new URLSearchParams(nav.search), vi.fn()],
  };
});

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: (...a: unknown[]) => apiMock(...a) };
});

beforeEach(() => {
  sessionStorage.clear();
  nav.search = '';
  apiMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('CandidateLogin — Phase D revocation banner', () => {
  it('renders the candidate tenant-suspend copy when scope=tenant', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'tenant' }));
    render(<CandidateLogin />);
    expect(screen.getByText("Your organisation's access is paused.")).toBeTruthy();
    expect(screen.getByText(/organisation's access has been suspended/i)).toBeTruthy();
  });

  it('renders the candidate user-disable copy when scope=user', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'user' }));
    render(<CandidateLogin />);
    expect(screen.getByText('Your access has been removed.')).toBeTruthy();
    expect(screen.getByText(/contact your assessment administrator/i)).toBeTruthy();
  });

  it('renders no banner when no scope is stashed (normal sign-in)', () => {
    render(<CandidateLogin />);
    expect(screen.queryByText("Your organisation's access is paused.")).toBeNull();
    expect(screen.queryByText('Your access has been removed.')).toBeNull();
    // The normal magic-link form is still present.
    expect(screen.getByRole('button', { name: /Send me a sign-in link/i })).toBeTruthy();
  });
});

describe('CandidateLogin — organisation (tenant) handling', () => {
  const submitBtn = (): HTMLButtonElement =>
    screen.getByRole('button', { name: /Send me a sign-in link/i }) as HTMLButtonElement;

  const requestBody = (): { email: string; tenant_slug: string } => {
    const call = apiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('/auth/candidate/request-link');
    expect(call[1].method).toBe('POST');
    return JSON.parse(call[1].body) as { email: string; tenant_slug: string };
  };

  it('?tenant= is used as the tenant slug and no Organisation code field is shown', async () => {
    nav.search = '?tenant=Acme-College';
    render(<CandidateLogin />);
    expect(screen.queryByLabelText('Organisation code')).toBeNull();

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'asha@example.com' } });
    expect(submitBtn().disabled).toBe(false);
    fireEvent.click(submitBtn());

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(requestBody()).toEqual({ email: 'asha@example.com', tenant_slug: 'acme-college' });
    await screen.findByText(/we just sent you a sign-in link/i);
  });

  it('without ?tenant= it asks for an Organisation code and sends what was typed', async () => {
    render(<CandidateLogin />);
    const org = screen.getByLabelText('Organisation code');
    expect(org).toBeTruthy();

    // Disabled until BOTH the organisation code and the email are filled in.
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'asha@example.com' } });
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(org, { target: { value: '  Acme-College ' } });
    expect(submitBtn().disabled).toBe(false);

    fireEvent.click(submitBtn());
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const body = requestBody();
    expect(body.tenant_slug).toBe('acme-college');
    // Regression: the old hard-coded tenant must never be sent.
    expect(JSON.stringify(body)).not.toContain('wipro-soc');
  });

  it('a blank ?tenant= counts as absent', () => {
    nav.search = '?tenant=%20';
    render(<CandidateLogin />);
    expect(screen.getByLabelText('Organisation code')).toBeTruthy();
  });
});
