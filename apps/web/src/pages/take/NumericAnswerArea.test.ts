import { describe, it, expect } from 'vitest';
import { parseNumericInput } from './NumericAnswerArea.js';

describe('parseNumericInput', () => {
  it('accepts plain, decimal, comma-grouped, signed, exponent', () => {
    expect(parseNumericInput('12.5')).toBe(12.5);
    expect(parseNumericInput('1,250')).toBe(1250);
    expect(parseNumericInput(' -3 ')).toBe(-3);
    expect(parseNumericInput('.5')).toBe(0.5);
    expect(parseNumericInput('2e3')).toBe(2000);
    expect(parseNumericInput('0')).toBe(0);
  });
  it('rejects empty and non-numeric text', () => {
    for (const bad of ['', '  ', 'abc', '12abc', '1.2.3', '--1', '12 5']) {
      expect(parseNumericInput(bad)).toBeNull();
    }
  });
});
