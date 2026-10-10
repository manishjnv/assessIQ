import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TryPage } from './Try';

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderTry = () =>
  render(
    <MemoryRouter>
      <TryPage />
    </MemoryRouter>,
  );

describe('/try demo', () => {
  it('full flow makes zero network requests', () => {
    renderTry();
    fireEvent.click(screen.getByText('Start the sample assessment'));
    fireEvent.click(screen.getByLabelText('Question 4: unanswered')); // navigator
    fireEvent.click(screen.getByLabelText(/401/));
    fireEvent.click(screen.getByLabelText('Question 2: unanswered'));
    fireEvent.change(screen.getByLabelText('Your answer (a number)'), { target: { value: '54' } });
    fireEvent.click(screen.getByText('Submit assessment'));
    expect(screen.getByText(/questions are unanswered/)).toBeTruthy();
    fireEvent.click(document.querySelector('[data-test-id="try-confirm-submit"]')!);
    expect(screen.getByText('Question breakdown')).toBeTruthy();
    expect(screen.getByText('20 / 60 points (33.3%)')).toBeTruthy();
    expect(screen.getAllByText('In a real assessment this is graded by AssessIQ.').length).toBe(1);
    expect(screen.getByText('View a sample certificate').getAttribute('href')).toBe('/try/certificate');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('timer auto-submits at 0 and shows the result', () => {
    vi.useFakeTimers();
    renderTry();
    fireEvent.click(screen.getByText('Start the sample assessment'));
    expect(screen.queryByText('Question breakdown')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 1500);
    });
    expect(screen.getByText('Time is up. Here is your score.')).toBeTruthy();
    expect(screen.getByText('0 / 60 points (0%)')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
