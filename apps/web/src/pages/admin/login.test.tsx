/**
 * Unit tests for AdminLogin — Phase D state-aware revocation banner.
 *
 * The banner is driven entirely client-side by the `aiq.lastAuthScope`
 * sessionStorage key (stashed by lib/session.ts on a 401-with-scope). These
 * tests prove the render behaviour that cannot be exercised on prod without
 * actually suspending a tenant / disabling a user.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { AdminLogin } from './login';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...(actual as object), useNavigate: vi.fn() };
});

beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(vi.fn());
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('AdminLogin — Phase D revocation banner', () => {
  it('renders the tenant-suspend banner when scope=tenant', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'tenant' }));
    render(<AdminLogin />);
    expect(screen.getByText("Your organisation's access is paused.")).toBeTruthy();
    expect(screen.getByText(/suspended or archived your company workspace/i)).toBeTruthy();
  });

  it('renders the user-disable banner when scope=user', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'user' }));
    render(<AdminLogin />);
    expect(screen.getByText('Your account has been disabled.')).toBeTruthy();
  });

  it('renders no banner when no scope is stashed', () => {
    render(<AdminLogin />);
    expect(screen.queryByText("Your organisation's access is paused.")).toBeNull();
    expect(screen.queryByText('Your account has been disabled.')).toBeNull();
  });

  it('is single-shot — clears the key and shows nothing on a fresh mount', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'tenant' }));
    render(<AdminLogin />);
    expect(screen.getByText("Your organisation's access is paused.")).toBeTruthy();
    // The key was consumed on first read.
    expect(sessionStorage.getItem('aiq.lastAuthScope')).toBeNull();

    cleanup();
    render(<AdminLogin />);
    expect(screen.queryByText("Your organisation's access is paused.")).toBeNull();
  });

  it('always renders the sign-in actions regardless of banner', () => {
    render(<AdminLogin />);
    expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Email me a sign-in code/i })).toBeTruthy();
  });
});
