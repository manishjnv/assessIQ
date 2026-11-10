import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TryPage } from './Try';
import { FREE_EXAMS } from './freeTests';

const APT = FREE_EXAMS['aptitude']!;
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
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/try/:exam/:set" element={<TryPage />} />
      </Routes>
    </MemoryRouter>,
  );

/** Answer every question by radio position (the draw is random), then submit. */
function runThrough(level: 'easy' | 'medium' | 'hard', right: (n: number) => boolean): void {
  const pool = APT.sets[level].pool;
  for (let n = 1; n <= 10; n++) {
    fireEvent.click(screen.getByLabelText(new RegExp(`^Question ${n},`)));
    const stem = document.querySelector('.aiq-attempt-q-text')!.textContent!;
    const item = pool.find((i) => i.prompt === stem)!;
    fireEvent.click(screen.getAllByRole('radio')[right(n) ? item.correct : (item.correct + 1) % 4]!);
  }
  fireEvent.click(screen.getByText('Finish assessment'));
  fireEvent.click(screen.getByText('Submit assessment'));
  fireEvent.click(screen.getByText('Submit now'));
}

const setVisibility = (state: 'hidden' | 'visible'): void => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('intro modes', () => {
  it('defaults to Mock, an unknown mode is Mock, ?mode=real preselects Real', () => {
    renderAt('/try/aptitude/easy');
    expect(screen.getByRole('button', { name: /^Mock/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Start the easy test')).toBeTruthy();
    cleanup();
    renderAt('/try/aptitude/easy?mode=bogus');
    expect(screen.getByRole('button', { name: /^Mock/ }).getAttribute('aria-pressed')).toBe('true');
    cleanup();
    renderAt('/try/aptitude/easy?mode=real');
    expect(screen.getByRole('button', { name: /^Real/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Start in Real mode')).toBeTruthy();
    expect(screen.getByText(/It is not proctored, nothing is recorded or sent/)).toBeTruthy();
    expect(screen.getByText(/Real mode is without camera/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secure|verified/i);
  });

  it('toggling the mode does not add history entries', () => {
    renderAt('/try/aptitude/easy');
    const before = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: /^Real/ }));
    expect(screen.getByText('Start in Real mode')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Mock/ }));
    expect(screen.getByText('Start the easy test')).toBeTruthy();
    expect(window.history.length).toBe(before);
  });
});

describe('Real mode run', () => {
  it('fullscreenEnabled undefined: starts without error and shows the note; logo is not a link; chip says Real', () => {
    renderAt('/try/aptitude/easy?mode=real');
    fireEvent.click(screen.getByText('Start in Real mode'));
    expect(screen.getByText('Full screen is not available here. Keep this tab open.')).toBeTruthy();
    expect(screen.getByText('Practice · Real')).toBeTruthy();
    expect(document.querySelector('.aiq-take-root a[href="/"]')).toBeNull();
  });

  it('a rejected requestFullscreen still starts the test', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    const req = vi.fn().mockRejectedValue(new Error('denied'));
    document.documentElement.requestFullscreen = req;
    renderAt('/try/aptitude/easy?mode=real');
    await act(async () => {
      fireEvent.click(screen.getByText('Start in Real mode'));
    });
    expect(req).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Practice · Real')).toBeTruthy();
    expect(screen.getByText('Full screen is not available here. Keep this tab open.')).toBeTruthy();
    Object.defineProperty(document, 'fullscreenEnabled', { value: undefined, configurable: true });
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  });

  it('two hidden-visible cycles show "2 times" as a status; Mock attaches no visibilitychange listener', () => {
    const add = vi.spyOn(document, 'addEventListener');
    renderAt('/try/aptitude/easy');
    fireEvent.click(screen.getByText('Start the easy test'));
    expect(add.mock.calls.some((c) => c[0] === 'visibilitychange')).toBe(false);
    cleanup();
    renderAt('/try/aptitude/easy?mode=real');
    fireEvent.click(screen.getByText('Start in Real mode'));
    expect(add.mock.calls.some((c) => c[0] === 'visibilitychange')).toBe(true);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(screen.getByText(/You left the test 1 time\./)).toBeTruthy();
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    const msg = screen.getByText(/You left the test 2 times\. Nothing is recorded here/);
    expect(msg.closest('[role="status"]')).toBeTruthy();
  });

  it('full Real run: zero network, empty sessionStorage; answers hidden until the click; same questions after; best saved first', () => {
    renderAt('/try/aptitude/easy?mode=real');
    fireEvent.click(screen.getByText('Start in Real mode'));
    runThrough('easy', (n) => n !== 2 && n !== 5);
    expect(screen.getByText('8 / 10 correct (80%)')).toBeTruthy();
    expect(screen.getByText('Your Real mode score')).toBeTruthy();
    expect(screen.getByText('Not correct: Q2, Q5 · Not answered: none')).toBeTruthy();
    // before the click: no breakdown, no model answer, no explanation
    expect(screen.queryByText('Question breakdown')).toBeNull();
    expect(screen.queryByText('Correct answer:')).toBeNull();
    expect(document.querySelectorAll('[data-question-id]')).toHaveLength(0);
    // the best is saved before the reveal
    expect(JSON.parse(window.localStorage.getItem('aiq-free-best')!)).toEqual({ aptitude: { easy: { real: 80 } } });
    expect(screen.getByText(/Best on this device: Real 80%/)).toBeTruthy();
    expect(decodeURIComponent(document.querySelector('[data-test-id="free-whatsapp"]')!.getAttribute('href')!)).toContain('Real mode');
    expect(document.querySelector('[data-test-id="free-end"]')!.getAttribute('href')).toBe('/signup?src=try-real');
    expect(screen.queryByText('Try it in Real mode')).toBeNull();
    expect(screen.getByText(/Free plan: 5 candidates/)).toBeTruthy();
    fireEvent.click(screen.getByText('Show answers and explanations'));
    expect(document.querySelectorAll('[data-question-id]')).toHaveLength(10);
    expect(document.activeElement?.textContent).toBe('Question breakdown');
    expect(screen.getAllByText('Correct answer:')).toHaveLength(10);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('Mock result offers Real', () => {
  it('shows "Try it in Real mode" and returns to a Real intro; end link is src=try; logo links home in the run', () => {
    renderAt('/try/aptitude/easy');
    fireEvent.click(screen.getByText('Start the easy test'));
    expect(document.querySelector('.aiq-take-root a[href="/"]')).toBeTruthy();
    runThrough('easy', () => true);
    expect(screen.getByText('Question breakdown')).toBeTruthy();
    expect(document.querySelector('[data-test-id="free-end"]')!.getAttribute('href')).toBe('/signup?src=try');
    fireEvent.click(screen.getByText('Try it in Real mode'));
    expect(screen.getByRole('button', { name: /^Real/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Start in Real mode')).toBeTruthy();
  });
});
