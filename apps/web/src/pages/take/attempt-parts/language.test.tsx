/** EXP-9 A4: the Hindi view keeps the English answer index space and never shows the rationale. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { FrozenQuestionWire } from '@assessiq/candidate-ui';
import { McqAnswerArea } from '../McqAnswerArea';
import { hasHindi, localize } from './language';

const q = {
  question_id: 'q1', position: 1, type: 'mcq',
  content: {
    question: 'Sample question', options: ['one', 'two', 'three', 'four'],
    i18n: { hi: { question: 'नमूना प्रश्न', options: ['एक', 'दो', 'तीन', 'चार'], rationale: 'छिपा' } },
  },
} as unknown as FrozenQuestionWire;

afterEach(cleanup);

function pick(view: FrozenQuestionWire, label: string): unknown {
  const onAnswerChange = vi.fn();
  render(<McqAnswerArea question={view} answer={null} disabled={false} onAnswerChange={onAnswerChange} />);
  fireEvent.click(screen.getByText(label));
  return onAnswerChange.mock.calls[0]?.[0];
}

describe('localize', () => {
  it('same click, same payload in English and Hindi', () => {
    expect(hasHindi(q)).toBe(true);
    const en = pick(localize(q, 'en'), 'two');
    cleanup();
    const hi = pick(localize(q, 'hi'), 'दो');
    expect(hi).toEqual(en);
    expect(hi).toEqual({ selected: 1 });
  });
  it('Hindi view has the Hindi stem and options and no overlay or rationale', () => {
    const c = localize(q, 'hi').content as Record<string, unknown>;
    expect(c['question']).toBe('नमूना प्रश्न');
    expect(JSON.stringify(c)).not.toContain('छिपा');
    expect(c['i18n']).toBeUndefined();
  });
  it('a question with no overlay stays English', () => {
    const plain = { ...q, content: { question: 'Q', options: ['a', 'b'] } } as unknown as FrozenQuestionWire;
    expect(hasHindi(plain)).toBe(false);
    expect(localize(plain, 'hi')).toBe(plain);
  });
});
