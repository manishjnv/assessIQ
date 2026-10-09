/**
 * FU-D3 / FR14 — /admin/settings/help-content is platform-only.
 * Verifies (1) App.tsx wires the route behind role="super_admin" and
 * (2) a tenant admin hitting that gate sees "no access" and no children.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequireSession } from './RequireSession';
import { useSession } from './session';

vi.mock('./session', () => ({ useSession: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('help-content route gate', () => {
  it('App.tsx gates the route with role="super_admin"', () => {
    const src = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('path="/admin/settings/help-content"'));
    expect(line).toBeDefined();
    expect(line).toContain('<RequireSession role="super_admin">');
  });

  it('denies a tenant admin (role=admin) and renders no children', () => {
    vi.mocked(useSession).mockReturnValue({
      session: { user: { role: 'admin' }, mfaStatus: 'verified' },
      loading: false,
    } as unknown as ReturnType<typeof useSession>);
    render(
      <MemoryRouter>
        <RequireSession role="super_admin">
          <p>help editor</p>
        </RequireSession>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('You do not have access');
    expect(screen.queryByText('help editor')).toBeNull();
  });
});
