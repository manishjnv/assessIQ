import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TryPage } from './Try';
import { FREE_SETS } from './freeAptitude';

const fetchMock = vi.fn();
const xhrOpen = vi.fn();
const beacon = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', function () {
    return { open: xhrOpen };
  });
  navigator.sendBeacon = beacon as never;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/try" element={<TryPage />} />
        <Route path="/try/aptitude/:set" element={<TryPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('/try/aptitude/:set', () => {
  it('easy: answer all right, submit, see score, bands, sections, weakest topic and share; zero network', () => {
    renderAt('/try/aptitude/easy');
    expect(screen.getByText(/Your answers stay in your browser/)).toBeTruthy();
    fireEvent.click(screen.getByText('Start the easy test'));
    // Pick the correct option for each of the 10 questions through the navigator.
    const pool = FREE_SETS.easy.pool;
    for (let n = 1; n <= 10; n++) {
      fireEvent.click(screen.getByLabelText(new RegExp(`^Question ${n},`)));
      const heading = document.querySelector('h1')!.textContent!;
      const item = pool.find((i) => i.prompt === heading);
      expect(item, heading).toBeTruthy();
      fireEvent.click(screen.getAllByRole('radio')[item!.correct]!);
    }
    fireEvent.click(screen.getByText('Submit assessment'));
    fireEvent.click(document.querySelector('[data-test-id="try-confirm-submit"]')!);
    expect(screen.getByText('10 / 10 correct (100%)')).toBeTruthy();
    expect(screen.getByText('Top scorer')).toBeTruthy();
    expect(document.querySelector('[data-test-id="free-sections"]')!.children).toHaveLength(3);
    expect(screen.getByText(/No weak topic/)).toBeTruthy();
    expect(screen.getByText('Next: Campus level test').getAttribute('href')).toBe('/try/aptitude/medium');
    expect(document.querySelector('[data-test-id="free-end"]')!.getAttribute('href')).toBe('/signup?src=try');
    expect(document.querySelector('[data-test-id="free-whatsapp"]')!.getAttribute('href')).toContain('wa.me');
    expect(JSON.parse(window.localStorage.getItem('aiq-free-aptitude-best')!)).toEqual({ easy: 100 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('unknown set redirects to the /try demo', () => {
    renderAt('/try/aptitude/nope');
    expect(screen.getByText('Start the sample assessment')).toBeTruthy();
  });
});
