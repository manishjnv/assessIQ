/**
 * Unit tests for CandidateLogin — Phase D state-aware revocation banner
 * (candidate audience). Same single-shot `aiq.lastAuthScope` mechanism as the
 * admin login, with calmer assessment-facing copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CandidateLogin } from './CandidateLogin';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...(actual as object),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

beforeEach(() => {
  sessionStorage.clear();
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
    expect(screen.getByText(/assessment workspace has been suspended/i)).toBeTruthy();
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
