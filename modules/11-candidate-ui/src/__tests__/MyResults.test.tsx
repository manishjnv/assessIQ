// Tests for the candidate portal results list (/candidate/results).
// Pattern: vitest + jsdom + @testing-library/react, matching MyCertificates.test.tsx.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MyResults } from '../components';
import type { MyResultsResponseWire } from '../types';

const { mockListMyResults, mockSeen } = vi.hoisted(() => ({
  mockListMyResults: vi.fn<() => Promise<MyResultsResponseWire>>(),
  mockSeen: vi.fn(async (_id: string) => ({ seen: true as const })),
}));

vi.mock('../api.js', () => ({
  listMyResults: mockListMyResults,
  markResultSeen: mockSeen,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TWO_RESULTS: MyResultsResponseWire = {
  items: [
    {
      attempt_id: 'att-2',
      assessment_name: 'Aptitude Test — Round 2',
      released_at: '2026-10-02T09:30:00.000Z',
      total_earned: 42,
      total_max: 60,
      percent: 70,
      passed: true,
      certificate: { credential_id: 'CERT-001', verify_url: 'https://assessiq.example.com/verify/CERT-001' },
    },
    {
      attempt_id: 'att-1',
      assessment_name: 'Aptitude Test — Round 1',
      released_at: '2026-10-01T09:30:00.000Z',
      total_earned: 20,
      total_max: 60,
      percent: 33.3,
      passed: false,
      pass_mark_pct: 65,
      certificate: null,
    },
  ],
};

describe('MyResults', () => {
  it('shows a loading spinner before the API resolves', () => {
    mockListMyResults.mockReturnValue(new Promise(() => {}));
    render(<MyResults />);
    expect(screen.getByRole('status', { name: 'Loading your results' })).toBeDefined();
  });

  it('lists released results with score, pass state, date and certificate link', async () => {
    mockListMyResults.mockResolvedValue(TWO_RESULTS);
    const { container } = render(<MyResults />);

    await screen.findByText('Aptitude Test — Round 2');
    expect(screen.getByText('Aptitude Test — Round 1')).toBeDefined();
    expect(screen.getByText('2 results')).toBeDefined();

    const text = container.textContent ?? '';
    expect(text).toContain('42 / 60 (70%)');
    expect(text).toContain('20 / 60 (33.3%)');
    expect(text).toContain('Released Oct 2, 2026');
    expect(text).toContain('Released Oct 1, 2026');
    expect(screen.getByText('Passed')).toBeDefined();
    expect(screen.getByText('Not passed')).toBeDefined();
    expect(text).toContain('Below the pass mark of 65%.');
    expect(text).toContain('You earn a certificate every time you pass. The pass mark for this assessment is 65%.');

    // Only the first result earned a certificate.
    const links = screen.getAllByRole('link', { name: /View certificate/ });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://assessiq.example.com/verify/CERT-001');
  });

  it('Z-12: shows a New chip only on unopened results and marks that one seen', async () => {
    mockListMyResults.mockResolvedValue({
      items: [{ ...TWO_RESULTS.items[0]!, is_new: true }, { ...TWO_RESULTS.items[1]!, is_new: false }],
    });
    const seen = vi.fn();
    window.addEventListener('aiq:result-seen', seen);
    render(<MyResults />);
    await screen.findByText('Aptitude Test — Round 2');
    expect(screen.getAllByText('New')).toHaveLength(1);
    await waitFor(() => expect(mockSeen).toHaveBeenCalledWith('att-2'));
    expect(mockSeen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    window.removeEventListener('aiq:result-seen', seen);
  });

  it('shows the empty state when nothing has been released', async () => {
    mockListMyResults.mockResolvedValue({ items: [] });
    render(<MyResults />);
    await screen.findByText('No results yet.');
    expect(screen.getByText('0 results')).toBeDefined();
  });

  it('shows what happened and what to do when the list cannot be loaded', async () => {
    mockListMyResults.mockRejectedValue(new Error('boom'));
    render(<MyResults />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("could not load your results");
    expect(alert.textContent).toContain('Refresh');
  });
});
