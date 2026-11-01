/**
 * Z-183: the finish summary table says it shows only the current section on a test with sections.
 *   T1  sectioned: heading "Questions in this section" and the closed-section line are shown
 *   T2  not sectioned (default): neither the new heading nor the line appears
 *   T3  sectioned: counters and filter tabs keep their numbers
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { FrozenQuestionWire } from '@assessiq/candidate-ui';
import { FinishSummary, type SummaryRow } from './FinishSummary';

function q(id: string, position: number): FrozenQuestionWire {
  return {
    question_id: id,
    position,
    type: 'mcq',
    content: { question: `Question text ${position}`, options: ['A', 'B'] },
  } as unknown as FrozenQuestionWire;
}

const rows: SummaryRow[] = [
  { q: q('q1', 1), position: 1, answer: { selected: 0 }, flagged: false },
  { q: q('q2', 2), position: 2, answer: undefined, flagged: true },
];

function renderSummary(sectioned?: boolean): void {
  render(
    <FinishSummary
      rows={rows}
      answered={1}
      total={2}
      flagged={1}
      endsAt={null}
      sectioned={sectioned}
      onOpen={() => {}}
      onBack={() => {}}
      onSubmit={() => {}}
      submitting={false}
    />,
  );
}

afterEach(() => cleanup());

describe('FinishSummary section wording (Z-183)', () => {
  it('T1 sectioned: shows the heading and the closed-section line', () => {
    renderSummary(true);
    expect(screen.getByRole('heading', { name: 'Questions in this section' })).toBeTruthy();
    expect(screen.getByText('Earlier sections are closed and cannot be changed.')).toBeTruthy();
  });

  it('T2 not sectioned: neither the new heading nor the line appears', () => {
    renderSummary(false);
    expect(screen.queryByText('Questions in this section')).toBeNull();
    expect(screen.queryByText('Earlier sections are closed and cannot be changed.')).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('T2b default (prop omitted) behaves as not sectioned', () => {
    renderSummary();
    expect(screen.queryByText('Questions in this section')).toBeNull();
  });

  it('T3 sectioned: counters and filter tabs keep their numbers', () => {
    renderSummary(true);
    const group = screen.getByRole('group', { name: 'Filter questions' });
    expect(within(group).getByRole('button', { name: 'All · 2' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Open · 1' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Flagged · 1' })).toBeTruthy();
    expect(document.querySelector('.aiq-fs-stats')?.textContent).toContain('1 / 2');
  });
});
