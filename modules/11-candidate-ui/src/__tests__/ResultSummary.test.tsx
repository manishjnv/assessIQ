// Tests for ResultSummary — the candidate-facing COMPLETE result.
// Owner rule P1: total, percent, pass/fail and certificate link only.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ResultSummary } from '../components';

afterEach(cleanup);

describe('ResultSummary', () => {
  it('shows "total / max (percent%)" and a Passed chip', () => {
    const { container } = render(
      <ResultSummary totalEarned={42} totalMax={60} percent={70} passed />,
    );
    expect(container.textContent).toContain('42 / 60 (70%)');
    expect(screen.getByText('Passed')).toBeDefined();
    expect(screen.queryByText('Not passed')).toBeNull();
  });

  it('shows Not passed (and not Passed) when the candidate did not pass', () => {
    render(<ResultSummary totalEarned={20} totalMax={60} percent={33.3} passed={false} />);
    expect(screen.getByText('Not passed')).toBeDefined();
    expect(screen.queryByText('Passed')).toBeNull();
  });

  it('trims fractional scores to at most 2 decimals and the percent to 1', () => {
    const { container } = render(
      <ResultSummary totalEarned={37.5} totalMax={50.25} percent={74.6} passed />,
    );
    expect(container.textContent).toContain('37.5 / 50.25 (74.6%)');
  });

  it('renders a certificate link only when one was issued', () => {
    const { rerender } = render(
      <ResultSummary totalEarned={42} totalMax={60} percent={70} passed certificate={null} />,
    );
    expect(screen.queryByRole('link')).toBeNull();

    rerender(
      <ResultSummary
        totalEarned={42}
        totalMax={60}
        percent={70}
        passed
        certificate={{ credential_id: 'CERT-001', verify_url: 'https://assessiq.example.com/verify/CERT-001' }}
      />,
    );
    const link = screen.getByRole('link', { name: /View certificate/ });
    expect(link.getAttribute('href')).toBe('https://assessiq.example.com/verify/CERT-001');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('P1 guard: never renders bands, a breakdown, insights or a percentile', () => {
    const { container } = render(
      <ResultSummary totalEarned={42} totalMax={60} percent={70} passed compact />,
    );
    expect(container.textContent ?? '').not.toMatch(/band|breakdown|insight|percentile|strength|justification/i);
  });
});
