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

describe('KeyNav Z-168 keys', () => {
  it('arrows move, A-D / 1-5 pick, F flags; ignored while typing or with a modifier', () => {
    const p = vi.fn(), n = vi.fn(), pick = vi.fn(), flag = vi.fn();
    render(
      <>
        <KeyNav onPrev={p} onNext={n} onPick={pick} onFlag={flag} disabled={false} />
        <textarea aria-label="answer" />
      </>,
    );
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    fireEvent.keyDown(document.body, { key: 'c' });
    fireEvent.keyDown(document.body, { key: '5' });
    fireEvent.keyDown(document.body, { key: 'f' });
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText('answer'), { key: 'b' });
    expect(p).toHaveBeenCalledTimes(1);
    expect(n).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls).toEqual([[2], [4]]);
    expect(flag).toHaveBeenCalledTimes(1);
  });
});
