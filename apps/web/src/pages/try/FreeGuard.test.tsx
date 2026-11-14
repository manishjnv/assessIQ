import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TryPage } from './Try';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/try/:exam/:set" element={<TryPage />} />
      </Routes>
    </MemoryRouter>,
  );

/** Fire a cancelable beforeunload and report whether a listener asked the browser to warn. */
const leave = (): { prevented: boolean } => {
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented };
};

describe('beforeunload guard of a running free test', () => {
  for (const [mode, label, path] of [
    ['mock', 'Start the easy test', '/try/aptitude/easy'],
    ['real', 'Start in Real mode', '/try/aptitude/easy?mode=real'],
  ] as const) {
    it(`${mode}: no warning on the intro, warns while running, removed after finish`, () => {
      renderAt(path);
      expect(leave().prevented).toBe(false);
      fireEvent.click(screen.getByText(label));
      expect(leave().prevented).toBe(true);
      fireEvent.click(screen.getByText('Finish assessment'));
      fireEvent.click(screen.getByText('Submit assessment'));
      fireEvent.click(screen.getByText('Submit now'));
      expect(document.querySelector('[data-test-id="free-score"]')).not.toBeNull();
      expect(leave().prevented).toBe(false);
    });
  }

  it('is removed on unmount', () => {
    const { unmount } = renderAt('/try/aptitude/easy');
    fireEvent.click(screen.getByText('Start the easy test'));
    const ev = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    unmount();
    expect(leave().prevented).toBe(false);
  });
});
