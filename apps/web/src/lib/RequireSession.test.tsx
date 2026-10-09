/**
 * RequireSession — role mismatch shows a notice instead of a silent redirect.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { useSession } from './session';

vi.mock('./session', () => ({ useSession: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderGate(role: 'admin' | 'super_admin', userRole: string) {
  vi.mocked(useSession).mockReturnValue({
    session: { user: { role: userRole }, mfaStatus: 'verified' },
    loading: false,
  } as unknown as ReturnType<typeof useSession>);
  render(
    <MemoryRouter>
      <RequireSession role={role}>
        <p>secret page</p>
      </RequireSession>
    </MemoryRouter>,
  );
}

describe('RequireSession role gate', () => {
  it('shows the notice and hides children for an admin on a super_admin route', () => {
    renderGate('super_admin', 'admin');
    expect(screen.getByRole('alert').textContent).toContain('You do not have access to this page.');
    expect(screen.getByText('Sign in with a different account').getAttribute('href')).toBe('/admin/login');
    expect(screen.queryByText('secret page')).toBeNull();
  });

  it('renders children when the role passes', () => {
    renderGate('admin', 'super_admin');
    expect(screen.getByText('secret page')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
