import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StructuredCaseAnswerArea, currentPicks, nextAnswer } from './StructuredCaseAnswerArea.js';
import { isAnsweredValue } from './Attempt.js';

afterEach(cleanup);

const q = {
  question_id: 'q1',
  content: {
    title: 'Brute force',
    context: 'Review the log.',
    log_excerpt: '10:01 failed logon admin',
    steps: [
      { id: 's1', prompt: 'Which lines?', select: 'many', options: ['l1', 'l2', 'l3'] },
      { id: 's2', prompt: 'Next?', select: 'one', options: ['Block', 'Ignore'] },
    ],
  },
};

describe('structured case helpers', () => {
  it('currentPicks reads only well-formed picks', () => {
    expect(currentPicks(null)).toEqual({});
    expect(currentPicks({ steps: [] })).toEqual({});
    expect(currentPicks({ steps: { s1: [0, 'x', 2], s2: 'a' } })).toEqual({ s1: [0, 2] });
  });
  it('nextAnswer toggles many, replaces one, and drops empty steps', () => {
    expect(nextAnswer(null, 's1', 'many', 2)).toEqual({ steps: { s1: [2] } });
    expect(nextAnswer({ steps: { s1: [2] } }, 's1', 'many', 0)).toEqual({ steps: { s1: [0, 2] } });
    expect(nextAnswer({ steps: { s1: [0, 2] } }, 's1', 'many', 0)).toEqual({ steps: { s1: [2] } });
    expect(nextAnswer({ steps: { s1: [2] } }, 's1', 'many', 2)).toEqual({ steps: {} });
    expect(nextAnswer({ steps: { s2: [0] } }, 's2', 'one', 1)).toEqual({ steps: { s2: [1] } });
  });
  it('an answer with no picks is unanswered, with a pick it is answered', () => {
    expect(isAnsweredValue({ steps: {} })).toBe(false);
    expect(isAnsweredValue({ steps: { s1: [] } })).toBe(false);
    expect(isAnsweredValue({ steps: { s1: [0] } })).toBe(true);
    expect(isAnsweredValue({ steps: [{ stepIndex: 0, response: 'x' }] })).toBe(true); // scenario shape unchanged
  });
});

describe('StructuredCaseAnswerArea', () => {
  it('shows context, the log in a <pre>, and radios / checkboxes per step', () => {
    const { container } = render(<StructuredCaseAnswerArea question={q} answer={null} disabled={false} onAnswerChange={() => {}} />);
    expect(screen.getByText('Review the log.')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toBe('10:01 failed logon admin');
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getAllByRole('group')).toHaveLength(2);
  });

  it('reports the canonical answer on change and reflects the saved one', () => {
    const onChange = vi.fn();
    render(<StructuredCaseAnswerArea question={q} answer={{ steps: { s2: [0] } }} disabled={false} onAnswerChange={onChange} />);
    expect((screen.getByRole('radio', { name: 'Block' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'l2' }));
    expect(onChange).toHaveBeenLastCalledWith({ steps: { s2: [0], s1: [1] } });
    fireEvent.click(screen.getByRole('radio', { name: 'Ignore' }));
    expect(onChange).toHaveBeenLastCalledWith({ steps: { s2: [1] } });
  });

  it('disabled locks every input', () => {
    render(<StructuredCaseAnswerArea question={q} answer={null} disabled onAnswerChange={() => {}} />);
    for (const i of [...screen.getAllByRole('checkbox'), ...screen.getAllByRole('radio')]) expect((i as HTMLInputElement).disabled).toBe(true);
  });

  it('a different question id gets fresh radio groups (answer area is keyed by question id in Attempt)', () => {
    const { container, rerender } = render(<StructuredCaseAnswerArea question={q} answer={{ steps: { s2: [0] } }} disabled={false} onAnswerChange={() => {}} />);
    rerender(<StructuredCaseAnswerArea question={{ ...q, question_id: 'q2' }} answer={null} disabled={false} onAnswerChange={() => {}} />);
    expect(container.querySelector('input[type=radio]')?.getAttribute('name')).toBe('sc-q2-s2');
    expect((screen.getByRole('radio', { name: 'Block' }) as HTMLInputElement).checked).toBe(false);
  });
});
