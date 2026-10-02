import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OrderingAnswerArea, currentOrdering, moveItem } from './OrderingAnswerArea.js';
import { isAnsweredValue } from './Attempt.js';

afterEach(cleanup);

const q = { question_id: 'q1', content: { question: 'Order', items: ['Detect', 'Contain', 'Eradicate'] } };

describe('ordering helpers', () => {
  it('currentOrdering falls back to the shown order for a missing or invalid answer', () => {
    expect(currentOrdering(null, 3)).toEqual([0, 1, 2]);
    expect(currentOrdering({ order: [0, 0, 1] }, 3)).toEqual([0, 1, 2]);
    expect(currentOrdering({ order: [0, 1] }, 3)).toEqual([0, 1, 2]);
    expect(currentOrdering({ order: [2, 0, 1] }, 3)).toEqual([2, 0, 1]);
  });
  it('moveItem swaps with the neighbour and ignores out-of-range moves', () => {
    expect(moveItem([0, 1, 2], 1, -1)).toEqual([1, 0, 2]);
    expect(moveItem([0, 1, 2], 1, 1)).toEqual([0, 2, 1]);
    expect(moveItem([0, 1, 2], 0, -1)).toEqual([0, 1, 2]);
    expect(moveItem([0, 1, 2], 2, 1)).toEqual([0, 1, 2]);
  });
  it('an ordering answer counts as answered', () => {
    expect(isAnsweredValue({ order: [1, 0, 2] })).toBe(true);
    expect(isAnsweredValue({ order: [] })).toBe(false);
  });
});

describe('OrderingAnswerArea', () => {
  it('renders items in the given order with labelled move buttons', () => {
    render(<OrderingAnswerArea question={q} answer={{ order: [2, 0, 1] }} disabled={false} onAnswerChange={() => {}} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('Eradicate');
    expect(rows[1]).toContain('Detect');
    expect(screen.getByRole('button', { name: 'Move item 2 up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move item 2 down' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Move item 1 up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move item 3 down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Move up / down reports the new arrangement as { order }', () => {
    const onChange = vi.fn();
    render(<OrderingAnswerArea question={q} answer={null} disabled={false} onAnswerChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move item 2 up' }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [1, 0, 2] });
    fireEvent.click(screen.getByRole('button', { name: 'Move item 1 down' }));
    expect(onChange).toHaveBeenLastCalledWith({ order: [1, 0, 2] });
  });

  it('disabled locks every button', () => {
    render(<OrderingAnswerArea question={q} answer={null} disabled onAnswerChange={() => {}} />);
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
