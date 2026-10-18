import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';
import { clientLog } from '../lib/logger';

vi.mock('../lib/logger', () => ({ clientLog: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('shows the message and logs once when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong. Reload the page.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/admin/login');
    expect(clientLog).toHaveBeenCalledTimes(1);
  });

  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>ok</p></ErrorBoundary>);
    expect(screen.getByText('ok')).toBeTruthy();
    expect(clientLog).not.toHaveBeenCalled();
  });
});
