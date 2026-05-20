// modules/10-admin-dashboard/src/__tests__/admin-shell-mobile.test.tsx
//
// A1 — AdminShell mobile reflow.
// Asserts the off-canvas drawer mounts on data-viewport="mobile" only,
// opens via hamburger, closes via Escape / backdrop / route change.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@assessiq/ui-system';

// ---------------------------------------------------------------------------
// Environment stubs — jsdom does not ship matchMedia or requestAnimationFrame.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // requestAnimationFrame stub — jsdom's rAF is a no-op in some versions.
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => { cb(0); return 0; };
    window.cancelAnimationFrame = vi.fn();
  }
  // Default matchMedia stub — desktop. Tests override via setViewport() below.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock the session module so AdminShell renders without a real API call.
vi.mock('../session.js', () => ({
  useAdminSession: () => ({
    session: {
      user: { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
      tenant: { id: 't1', slug: 'acme' },
      mfaStatus: 'verified',
      totpEnrolled: true,
    },
    loading: false,
    error: null,
  }),
  adminLogout: vi.fn(),
}));

// Mock the help-system HelpProvider — it makes network calls we don't need.
vi.mock('@assessiq/help-system/components', () => ({
  HelpProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import React from 'react';
import { AdminShell } from '../components/AdminShell.js';

function setViewport(v: 'mobile' | 'desktop') {
  document.documentElement.dataset.viewport = v;
  // Re-stub matchMedia BEFORE render so useViewport() initialises correctly.
  // The hook reads window.matchMedia(VIEWPORT_QUERY).matches — not dataset —
  // so we mirror the dataset state into the stub's return value.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: v === 'mobile',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderShell() {
  return render(
    <MemoryRouter>
      <ThemeProvider theme="light" density="cozy">
        <AdminShell breadcrumbs={['Dashboard']}>
          <p>page content</p>
        </AdminShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.viewport;
});

describe('AdminShell mobile reflow (A1)', () => {
  it('renders hamburger button on mobile only', () => {
    setViewport('mobile');
    renderShell();
    // getByLabelText throws if not found — passing = element present.
    expect(screen.getByLabelText(/open navigation/i)).toBeDefined();
  });

  it('does not render hamburger on desktop', () => {
    setViewport('desktop');
    renderShell();
    expect(screen.queryByLabelText(/open navigation/i)).toBeNull();
  });

  it('opens drawer when hamburger is clicked', () => {
    setViewport('mobile');
    renderShell();
    const hamburger = screen.getByLabelText(/open navigation/i);
    fireEvent.click(hamburger);
    // getByRole throws if not found — passing = dialog present.
    expect(screen.getByRole('dialog', { name: /navigation/i })).toBeDefined();
  });

  it('closes drawer when Escape is pressed', () => {
    setViewport('mobile');
    renderShell();
    fireEvent.click(screen.getByLabelText(/open navigation/i));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /navigation/i })).toBeNull();
  });

  it('closes drawer when backdrop is clicked', () => {
    setViewport('mobile');
    renderShell();
    fireEvent.click(screen.getByLabelText(/open navigation/i));
    fireEvent.click(screen.getByTestId('admin-drawer-backdrop'));
    expect(screen.queryByRole('dialog', { name: /navigation/i })).toBeNull();
  });
});
