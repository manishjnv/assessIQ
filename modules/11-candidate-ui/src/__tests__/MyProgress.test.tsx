// Tests for the candidate progress page (/candidate/progress, RW-84).
// Pattern: vitest + jsdom + @testing-library/react, matching MyResults.test.tsx.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MyProgress } from '../components';
import type { CandidateProgress } from '../api';

const { mockGetMyProgress } = vi.hoisted(() => ({
  mockGetMyProgress: vi.fn<() => Promise<CandidateProgress>>(),
}));

vi.mock('../api.js', () => ({ getMyProgress: mockGetMyProgress }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockGetMyProgress.mockReset();
});

const FULL: CandidateProgress = {
  attempts: [
    {
      attempt_id: 'a2', assessment_id: 's2', assessment_name: 'Maths Test 2', released_at: '2026-10-05T09:00:00.000Z',
      total_earned: 30, total_max: 30, score_pct: 100, passing_score_pct: 60, passed: true,
      certificate: { credential_id: 'C-1', verify_url: 'https://assessiq.example.com/verify/C-1' },
    },
    {
      attempt_id: 'a1', assessment_id: 's1', assessment_name: 'Maths Test 1', released_at: '2026-10-01T09:00:00.000Z',
      total_earned: 10, total_max: 20, score_pct: 50, passing_score_pct: 60, passed: false, certificate: null,
    },
  ],
  trend: [50, 100],
  subjects: [
    { node_id: 'g', label: 'Geometry', questions: 4, correct: 1, rate_pct: 25 },
    { node_id: 'a', label: 'Algebra', questions: 4, correct: 3, rate_pct: 75 },
    { node_id: 'o', label: 'Other', questions: 2, correct: 1, rate_pct: 50 },
  ],
};

describe('MyProgress', () => {
  it('shows a spinner before the API resolves', () => {
    mockGetMyProgress.mockReturnValue(new Promise(() => {}));
    render(<MyProgress />);
    expect(screen.getByLabelText('Loading your progress')).toBeTruthy();
  });

  it('shows the empty state when nothing is released', async () => {
    mockGetMyProgress.mockResolvedValue({ attempts: [], trend: [], subjects: [] });
    render(<MyProgress />);
    expect(await screen.findByText('No released results yet')).toBeTruthy();
    expect(screen.getByText('Your progress appears here after an organisation releases a result.')).toBeTruthy();
  });

  it('shows history rows, certificate link, subject chips and the sparkline', async () => {
    mockGetMyProgress.mockResolvedValue(FULL);
    const { container } = render(<MyProgress />);
    expect(await screen.findByText('Maths Test 2')).toBeTruthy();
    expect(screen.getByText('Maths Test 1')).toBeTruthy();
    expect(screen.getByText('30 / 30 (100%)')).toBeTruthy();
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.getByText('Not passed')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View' });
    expect(link.getAttribute('href')).toBe('https://assessiq.example.com/verify/C-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('Strong')).toBeTruthy();
    expect(screen.getByText('Developing')).toBeTruthy();
    expect(screen.getByText('Focus')).toBeTruthy();
    expect(screen.getByText('Geometry')).toBeTruthy();
    expect(container.querySelector('[data-test-id="progress-sparkline"]')).not.toBeNull();
    expect(container.querySelector('[data-help-id="candidate.progress.history"]')).not.toBeNull();
    expect(container.querySelector('[data-help-id="candidate.progress.subjects"]')).not.toBeNull();
  });

  it('shows a one-line note instead of a sparkline for a single point', async () => {
    mockGetMyProgress.mockResolvedValue({ ...FULL, attempts: [FULL.attempts[0]!], trend: [100] });
    const { container } = render(<MyProgress />);
    expect(await screen.findByText('Take one more test to see your score trend.')).toBeTruthy();
    expect(container.querySelector('[data-test-id="progress-sparkline"]')).toBeNull();
  });

  it('shows an error with Retry, and Retry reloads', async () => {
    mockGetMyProgress.mockRejectedValueOnce(new Error('boom'));
    render(<MyProgress />);
    expect(await screen.findByText('We could not load your progress.')).toBeTruthy();
    mockGetMyProgress.mockResolvedValueOnce(FULL);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Maths Test 2')).toBeTruthy());
    expect(mockGetMyProgress).toHaveBeenCalledTimes(2);
  });
});
