import { describe, it, expect } from 'vitest';
import { DEMO_QUESTIONS, fractionFor, scoreDemo, shareLinks } from './demoContent';

const q = (id: string) => DEMO_QUESTIONS.find((x) => x.id === id)!;

describe('demo scoring (deterministic, client-side)', () => {
  it('numeric: absolute tolerance, comma/space input, junk is wrong', () => {
    expect(fractionFor(q('d2'), 54)).toBe(1);
    expect(fractionFor(q('d2'), '54.4')).toBe(1); // tolerance 0.5
    expect(fractionFor(q('d2'), '54.6')).toBe(0);
    expect(fractionFor(q('d2'), 'abc')).toBe(0);
    expect(fractionFor(q('d6'), 30)).toBe(1); // tolerance 0 = exact
    expect(fractionFor(q('d6'), 30.01)).toBe(0);
    expect(fractionFor(q('d6'), null)).toBe(0);
  });

  it('multi-select: partial = (right - wrong) / |key|, floored at 0', () => {
    expect(fractionFor(q('d3'), [0, 2, 4])).toBe(1);
    expect(fractionFor(q('d3'), [0, 2])).toBeCloseTo(2 / 3);
    expect(fractionFor(q('d3'), [0, 1])).toBe(0); // 1 right - 1 wrong
    expect(fractionFor(q('d3'), [1, 3])).toBe(0);
    expect(fractionFor(q('d3'), [])).toBe(0);
    const strict = { ...q('d3'), partial: false };
    expect(fractionFor(strict, [0, 2])).toBe(0);
    expect(fractionFor(strict, [0, 2, 4])).toBe(1);
  });

  it('mcq/log exact index; written never scored', () => {
    expect(fractionFor(q('d1'), 1)).toBe(1);
    expect(fractionFor(q('d1'), 0)).toBe(0);
    expect(fractionFor(q('d5'), 1)).toBe(1);
    expect(fractionFor(q('d7'), 'anything')).toBe(0);
  });

  it('total: perfect = 60/60, written excluded, empty = 0', () => {
    const perfect = scoreDemo({ d1: 1, d2: 54, d3: [0, 2, 4], d4: 1, d5: 1, d6: 30, d7: 'text' });
    expect(perfect).toMatchObject({ earned: 60, max: 60, percent: 100, passed: true });
    const none = scoreDemo({});
    expect(none).toMatchObject({ earned: 0, max: 60, percent: 0, passed: false });
  });

  it('share links point at /try', () => {
    const l = shareLinks(80);
    expect(l.linkedin).toContain(encodeURIComponent('https://assessiq.in/try'));
    expect(decodeURIComponent(l.x)).toContain('80%');
    expect(l.whatsapp).toContain('wa.me');
  });
});
