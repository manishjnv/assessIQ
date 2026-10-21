import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { QuestionCountdown, secondsLeft } from './attempt-parts/QuestionCountdown';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('secondsLeft', () => {
  it('rounds up and never goes below zero', () => {
    const end = '2030-01-01T00:00:10.000Z';
    expect(secondsLeft(end, Date.parse('2030-01-01T00:00:00.000Z'))).toBe(10);
    expect(secondsLeft(end, Date.parse('2030-01-01T00:00:09.500Z'))).toBe(1);
    expect(secondsLeft(end, Date.parse('2030-01-01T00:00:20.000Z'))).toBe(0);
  });
});

describe('QuestionCountdown', () => {
  it('counts down and calls onExpire once at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const onExpire = vi.fn();
    render(<QuestionCountdown endsAt="2030-01-01T00:00:02.000Z" onExpire={onExpire} />);
    expect(screen.getByRole('timer').textContent).toBe('Time left for this question: 0:02');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer').textContent).toBe('Time left for this question: 0:01');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole('timer')).toBeNull();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
