// RW-80: "Review your answers" section on the candidate results list.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MyResults } from '../components';
import type { AttemptFeedbackWire, MyResultsResponseWire } from '../types';

const { mockList, mockFeedback } = vi.hoisted(() => ({
  mockList: vi.fn<() => Promise<MyResultsResponseWire>>(),
  mockFeedback: vi.fn<(id: string) => Promise<AttemptFeedbackWire>>(),
}));

vi.mock('../api.js', () => ({
  listMyResults: mockList,
  getAttemptFeedback: mockFeedback,
  markResultSeen: vi.fn(async () => ({ seen: true })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RESULT = {
  attempt_id: 'att-1',
  assessment_name: 'Aptitude Test',
  released_at: '2026-10-01T09:30:00.000Z',
  total_earned: 20,
  total_max: 60,
  percent: 33.3,
  passed: false,
  certificate: null,
};

const ITEM = {
  question_id: 'q1',
  position: 1,
  type: 'mcq',
  prompt: 'Which address is private?',
  your_answer: '8.8.8.8',
  outcome: 'incorrect' as const,
  score_earned: 0,
  score_max: 10,
  expected_answer: null,
  explanation: null,
  study: { unit: 'Subnetting', subject: 'Networking', topic: 't' },
};

describe('AttemptFeedback on MyResults', () => {
  it('is not rendered when the level is none (or absent)', async () => {
    mockList.mockResolvedValue({ items: [RESULT], feedback_level: 'none' });
    render(<MyResults />);
    await screen.findByText('Aptitude Test');
    expect(screen.queryByRole('button', { name: 'Review your answers' })).toBeNull();
  });

  it('fetches only on expand, renders rows with the study line, no expected column when none has one', async () => {
    mockList.mockResolvedValue({ items: [RESULT], feedback_level: 'right_wrong' });
    mockFeedback.mockResolvedValue({ level: 'right_wrong', items: [ITEM] });
    render(<MyResults />);
    const btn = await screen.findByRole('button', { name: 'Review your answers' });
    expect(mockFeedback).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await screen.findByText('Which address is private?');
    expect(mockFeedback).toHaveBeenCalledWith('att-1');
    expect(screen.getByText('Not correct')).toBeDefined();
    expect(screen.getByText('8.8.8.8')).toBeDefined();
    expect(screen.getByText('What to study: Subnetting (Networking)')).toBeDefined();
    expect(screen.queryByText(/Expected answer/)).toBeNull();
  });

  it('shows the expected answer and the explanation when present', async () => {
    mockList.mockResolvedValue({ items: [RESULT], feedback_level: 'with_ai_justification' });
    mockFeedback.mockResolvedValue({
      level: 'with_ai_justification',
      items: [{ ...ITEM, expected_answer: '10.0.0.1', explanation: 'Good answer: names the control.' }],
    });
    render(<MyResults />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review your answers' }));
    await screen.findByText('10.0.0.1');
    expect(screen.getByText('Good answer: names the control.')).toBeDefined();
  });

  it('shows an error with Retry, then the empty state', async () => {
    mockList.mockResolvedValue({ items: [RESULT], feedback_level: 'right_wrong' });
    mockFeedback.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ level: 'right_wrong', items: [] });
    render(<MyResults />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review your answers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('No questions to show.');
  });
});
