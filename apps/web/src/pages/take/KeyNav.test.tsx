/** Z-41 (WCAG 2.1.4): P and N shortcuts have an off switch kept per browser. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KeyNav, KeyShortcutsToggle, useKeyShortcuts } from './attempt-parts/KeyNav.js';

function Harness(props: { onPrev: () => void; onNext: () => void }) {
  const [on, setOn] = useKeyShortcuts();
  return (
    <>
      <KeyNav onPrev={props.onPrev} onNext={props.onNext} enabled={on} disabled={false} />
      <KeyShortcutsToggle on={on} onChange={setOn} />
      <textarea aria-label="answer" />
    </>
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('KeyNav shortcut switch', () => {
  it('is ON by default: P and N fire', () => {
    const p = vi.fn(), n = vi.fn();
    render(<Harness onPrev={p} onNext={n} />);
    expect((screen.getByLabelText('Keyboard shortcuts P and N') as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(document.body, { key: 'p' });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(p).toHaveBeenCalledTimes(1);
    expect(n).toHaveBeenCalledTimes(1);
  });

  it('OFF: keys do nothing and the choice is stored', () => {
    const p = vi.fn(), n = vi.fn();
    render(<Harness onPrev={p} onNext={n} />);
    fireEvent.click(screen.getByLabelText('Keyboard shortcuts P and N'));
    fireEvent.keyDown(document.body, { key: 'p' });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(p).not.toHaveBeenCalled();
    expect(n).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('aiq.take.keyShortcuts')).toBe('off');
  });

  it('starts OFF when the browser stored off', () => {
    window.localStorage.setItem('aiq.take.keyShortcuts', 'off');
    render(<Harness onPrev={vi.fn()} onNext={vi.fn()} />);
    expect((screen.getByLabelText('Keyboard shortcuts P and N') as HTMLInputElement).checked).toBe(false);
  });

  it('ignores keys typed in a text field', () => {
    const p = vi.fn(), n = vi.fn();
    render(<Harness onPrev={p} onNext={n} />);
    fireEvent.keyDown(screen.getByLabelText('answer'), { key: 'p' });
    fireEvent.keyDown(screen.getByLabelText('answer'), { key: 'n' });
    expect(p).not.toHaveBeenCalled();
    expect(n).not.toHaveBeenCalled();
  });

  it('still works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const p = vi.fn();
    render(<Harness onPrev={p} onNext={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(p).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Keyboard shortcuts P and N'));
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(p).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
