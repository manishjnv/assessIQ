import { describe, it, expect } from 'vitest';
import { csvQuote } from '../service.js';

describe('csvQuote formula-injection guard (RV77)', () => {
  it('prefixes a formula cell with an apostrophe inside the quotes', () => {
    expect(csvQuote('=1+1')).toBe(`"'=1+1"`);
  });
  it('quotes and escapes normal cells', () => {
    expect(csvQuote('a"b')).toBe('"a""b"');
    expect(csvQuote('abc')).toBe('"abc"');
  });
});
