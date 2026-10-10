import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.fn();
vi.mock('../lib/api', () => {
  class ApiCallError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  }
  return { api: (...a: unknown[]) => api(...a), ApiCallError };
});
vi.mock('../lib/session', () => ({ fetchWhoami: vi.fn() }));

import { ApiCallError } from '../lib/api';
import { InviteAccept } from './invite-accept';

const GENERIC = /Something went wrong/;

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/invite?token=tok123']}>
      <InviteAccept />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  api.mockReset();
});

describe('InviteAccept error mapping (RW-29)', () => {
  it('shows generic copy on a 500, not the server message', async () => {
    api.mockRejectedValue(new ApiCallError(500, { code: 'INTERNAL', message: 'db exploded' }));
    renderPage();
    await waitFor(() => expect(screen.getByText(GENERIC)).toBeTruthy());
    expect(screen.queryByText(/db exploded/)).toBeNull();
    expect(screen.queryByText(/expired, was already used/)).toBeNull();
  });

  it('never renders a raw "jwt malformed" message', async () => {
    api.mockRejectedValue(new ApiCallError(500, { code: 'X', message: 'jwt malformed' }));
    renderPage();
    await waitFor(() => expect(screen.getByText(GENERIC)).toBeTruthy());
    expect(screen.queryByText(/jwt malformed/)).toBeNull();
  });
});
