// Tests for ResultSummary — the candidate-facing COMPLETE result.
// Owner rule P1: total, percent, pass/fail and certificate link only.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ResultSummary } from '../components';
import { certificateRuleText } from '../copy';

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

  it('EX-1: a net-negative total shows the signed score, the negative-marking line and an empty ring', () => {
    const { container } = render(
      <ResultSummary
        totalEarned={-2.5}
        totalMax={40}
        percent={-6.3}
        passed={false}
        negativeMarking={{ enabled: true, penalty_total: 6 }}
      />,
    );
    expect(container.textContent).toContain('−2.5 / 40 (−6.3%)');
    expect(container.textContent).toContain('Negative marking: −6 deducted for wrong answers');
    expect(container.querySelector('[data-help-id="candidate.result.negative_marking"]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('Not passed')).toBeDefined();
  });

  it('EX-1: no negative-marking line when it is off', () => {
    const { container } = render(
      <ResultSummary totalEarned={20} totalMax={40} percent={50} passed negativeMarking={{ enabled: false, penalty_total: 0 }} />,
    );
    expect(container.textContent ?? '').not.toContain('Negative marking');
  });

  it('Z-16: explains the certificate rule when there is no certificate (fail and pass), with the real mark', () => {
    const rule = 'You earn a certificate every time you pass. The pass mark for this assessment is 65%.';
    expect(certificateRuleText(65)).toBe(rule);
    const { rerender } = render(
      <ResultSummary totalEarned={36} totalMax={60} percent={60} passed={false} passMark={65} certificate={null} />,
    );
    expect(screen.getByText(rule)).toBeDefined();
    rerender(<ResultSummary totalEarned={42} totalMax={60} percent={70} passed passMark={65} certificate={null} />);
    expect(screen.getByText(rule)).toBeDefined();
    rerender(
      <ResultSummary
        totalEarned={42}
        totalMax={60}
        percent={70}
        passed
        passMark={65}
        certificate={{ credential_id: 'C1', verify_url: 'https://x.example/verify/C1' }}
      />,
    );
    expect(screen.queryByText(rule)).toBeNull();
  });

  it('Z-16: hides every pass-mark number when the payload has none (never guesses 60 or 70)', () => {
    const { container } = render(
      <ResultSummary totalEarned={20} totalMax={60} percent={33.3} passed={false} certificate={null} />,
    );
    expect(container.textContent).toContain('Your score is 20 out of 60.');
    expect(container.textContent).not.toMatch(/pass mark of|to pass|(60|70)%/);
    expect(container.textContent).not.toContain('every time you pass');
  });

  it('Z-16: support line for pass and fail', () => {
    const { container, rerender } = render(
      <ResultSummary totalEarned={42} totalMax={60} percent={70} passed passMark={60} />,
    );
    const line = (): string | null => container.querySelector('[data-testid="result-support"]')?.textContent ?? null;
    expect(line()).toBe('Your score is 42 out of 60. You met the pass mark of 60%.');
    rerender(<ResultSummary totalEarned={20} totalMax={60} percent={33.3} passed={false} passMark={60} />);
    expect(line()).toBe('Your score is 20 out of 60. You need 60% to pass.');
  });

  it('P1 guard: never renders bands, a breakdown, insights or a percentile', () => {
    const { container } = render(
      <ResultSummary totalEarned={42} totalMax={60} percent={70} passed compact />,
    );
    expect(container.textContent ?? '').not.toMatch(/band|breakdown|insight|percentile|strength|justification/i);
  });
  describe('Z-9 plain result copy', () => {
    it('pass headline names the assessment and uses success tokens', () => {
      const { container } = render(
        <ResultSummary totalEarned={42} totalMax={60} percent={70} passed assessmentName="SOC L1" />,
      );
      expect(screen.getByText('You passed SOC L1.')).toBeDefined();
      const box = container.querySelector('[data-testid="result-outcome"]') as HTMLElement;
      expect(box.style.background).toContain('--aiq-color-success-soft');
      expect(box.style.borderLeft).toContain('--aiq-color-success');
    });

    it('fail uses warning tokens, never danger, with feedback + ask line', () => {
      const { container } = render(
        <ResultSummary totalEarned={20} totalMax={60} percent={33.3} passed={false} tenantName="Acme" feedbackOn />,
      );
      expect(screen.getByText('You did not reach the pass mark.')).toBeDefined();
      expect(
        screen.getByText('Use the feedback on each question to prepare. Ask Acme if you can try again.'),
      ).toBeDefined();
      const box = container.querySelector('[data-testid="result-outcome"]') as HTMLElement;
      expect(box.style.background).toContain('--aiq-color-warning-soft');
      expect(container.innerHTML).not.toContain('--aiq-color-danger');
      expect(container.textContent).toContain('(33.3%)');
    });

    it('fail without feedback shows only the ask line', () => {
      render(<ResultSummary totalEarned={20} totalMax={60} percent={33.3} passed={false} tenantName="Acme" />);
      expect(screen.getByText('Ask Acme if you can try again.')).toBeDefined();
    });

    it('list-row one-liners', () => {
      const cert = { credential_id: 'C1', verify_url: 'https://x.example/verify/C1' };
      const { container, rerender } = render(
        <ResultSummary compact totalEarned={42} totalMax={60} percent={70} passed certificate={cert} />,
      );
      const line = (): string | null => container.querySelector('[data-testid="result-oneliner"]')?.textContent ?? null;
      expect(line()).toBe('You passed. View your certificate.');
      rerender(<ResultSummary compact totalEarned={42} totalMax={60} percent={70} passed />);
      expect(line()).toBe('You passed.');
      rerender(<ResultSummary compact totalEarned={20} totalMax={60} percent={33} passed={false} />);
      expect(line()).toBe('Not passed.');
      rerender(<ResultSummary compact totalEarned={20} totalMax={60} percent={33} passed={false} passMark={65} />);
      expect(line()).toBe('Below the pass mark of 65%.');
      expect(container.querySelector('[data-testid="result-outcome"]')).toBeNull();
    });
  });
});
