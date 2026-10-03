import { describe, it, expect } from 'vitest';
import { csvEscape } from '../service.js';

describe('csvEscape formula-injection guard (RV77)', () => {
  it('prefixes a formula cell with an apostrophe', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('still quotes and leaves normal cells alone', () => {
    expect(csvEscape('=a,b')).toBe(`"'=a,b"`);
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(-5)).toBe('-5'); // numbers are not text
    expect(csvEscape(null)).toBe('');
  });
});
