import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { TryPage } from './Try';
import { ExamPickerPage, LevelPickerPage } from './FreePickers';
import { TryCertificatePage } from './TryCertificate';
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const Where = (): React.JSX.Element => <div data-test-id="where">{useLocation().pathname}</div>;

// Same route table as apps/web/src/App.tsx (the /try block). Keep both in step.
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/try" element={<ExamPickerPage />} />
        <Route path="/try/certificate" element={<TryCertificatePage />} />
        <Route path="/try/:exam" element={<LevelPickerPage />} />
        <Route path="/try/:exam/:set" element={<TryPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
const where = (): string => document.querySelector('[data-test-id="where"]')!.textContent!;

describe('/try exam picker', () => {
  it('lists only real exams from the registry, links to the level picker, home logo link, no network', () => {
    renderAt('/try');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Take a free test.');
    const cards = document.querySelector('[data-test-id="free-exams"]')!.children;
    expect(cards).toHaveLength(Object.keys(FREE_EXAMS).length);
    expect(cards[0]!.getAttribute('href')).toBe('/try/aptitude');
    expect(screen.getByText('More exams are coming.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe('/try/:exam level picker', () => {
  it('shows easy, medium and hard with minutes, items and this browser best score', () => {
    window.localStorage.setItem('aiq-free-aptitude-best', '{"easy":80}'); // old key still read
    renderAt('/try/aptitude');
    const cards = document.querySelector('[data-test-id="free-levels"]')!.children;
    expect(cards).toHaveLength(3);
    expect([...cards].map((c) => c.getAttribute('href'))).toEqual(['/try/aptitude/easy', '/try/aptitude/medium', '/try/aptitude/hard']);
    expect(cards[0]!.textContent).toContain(APT.sets.easy.title);
    expect(cards[0]!.textContent).toContain('10 questions, 8 minutes');
    expect(cards[0]!.textContent).toContain('Best on this device: 80%');
    expect(cards[1]!.textContent).toContain('Not tried');
  });

  it('unknown exam goes up to /try', () => {
    renderAt('/try/nope');
    expect(where()).toBe('/try');
    expect(screen.getByText('Take a free test.')).toBeTruthy();
  });
});

describe('/try/certificate is not swallowed by /try/:exam', () => {
  it('renders the sample certificate page', () => {
    renderAt('/try/certificate');
    expect(where()).toBe('/try/certificate');
    expect(screen.queryByText('Take a free test.')).toBeNull();
    expect(screen.getByText('Back to the free tests').getAttribute('href')).toBe('/try');
  });
});

describe('/try/:exam/:set', () => {
  it('easy: answer all right, submit, see score, bands, sections, weakest topic and share; zero network', () => {
    renderAt('/try/aptitude/easy'); // old deep link keeps working
    expect(screen.getByText(/Your answers stay in your browser/)).toBeTruthy();
    fireEvent.click(screen.getByText('Start the easy test'));
    const pool = APT.sets.easy.pool;
    for (let n = 1; n <= 10; n++) {
      fireEvent.click(screen.getByLabelText(new RegExp(`^Question ${n},`)));
      const stem = document.querySelector('.aiq-attempt-q-text')!.textContent!;
      const item = pool.find((i) => i.prompt === stem);
      expect(item, stem).toBeTruthy();
      fireEvent.click(screen.getAllByRole('radio')[item!.correct]!); // by position, never by text
    }
    fireEvent.click(screen.getByText('Finish assessment'));
    fireEvent.click(screen.getByText('Submit assessment'));
    fireEvent.click(screen.getByText('Submit now'));
    expect(screen.getByText('10 / 10 correct (100%)')).toBeTruthy();
    expect(screen.getByText('Top scorer')).toBeTruthy();
    expect(document.querySelector('[data-test-id="free-sections"]')!.children).toHaveLength(3);
    expect(screen.getByText(/No weak topic/)).toBeTruthy();
    expect(screen.getByText('Next: Campus level test').getAttribute('href')).toBe('/try/aptitude/medium');
    expect(screen.getByText('All levels').getAttribute('href')).toBe('/try/aptitude');
    expect(document.querySelector('[data-test-id="free-end"]')!.getAttribute('href')).toBe('/signup?src=try');
    expect(document.querySelector('[data-test-id="free-whatsapp"]')!.getAttribute('href')).toContain('wa.me');
    expect(JSON.parse(window.localStorage.getItem('aiq-free-best')!)).toEqual({ aptitude: { easy: 100 } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('runs on the real take layout: question pane beside a navigator panel, expanded by default', () => {
    renderAt('/try/aptitude/medium');
    fireEvent.click(screen.getByText('Start the medium test'));
    const middle = document.querySelector('.aiq-attempt-middle')!;
    expect(middle.getAttribute('data-nav-collapsed')).toBeNull();
    const main = middle.querySelector('main.aiq-attempt-main')!;
    expect(main.querySelector('.aiq-attempt-q-text')).toBeTruthy();
    expect(main.querySelector('nav[aria-label="Question navigator"]')).toBeNull();
    expect(middle.querySelector('aside.aiq-attempt-aside nav[aria-label="Question navigator"]')).toBeTruthy();
    expect(screen.getByText('Practice')).toBeTruthy();
  });

  it('unknown set redirects up to the level picker, unknown exam up to /try', () => {
    renderAt('/try/aptitude/nope');
    expect(where()).toBe('/try/aptitude');
    cleanup();
    renderAt('/try/nope/easy');
    expect(where()).toBe('/try');
  });
});
