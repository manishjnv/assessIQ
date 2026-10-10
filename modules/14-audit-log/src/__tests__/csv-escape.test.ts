import { describe, it, expect } from 'vitest';
import { auditCsvCell } from '../service.js';

describe('auditCsvCell formula-injection guard (RV77)', () => {
  it('prefixes a formula cell with an apostrophe', () => {
    expect(auditCsvCell('=1+1')).toBe("'=1+1");
    expect(auditCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('still quotes and leaves normal cells alone', () => {
    expect(auditCsvCell('=a,b')).toBe(`"'=a,b"`);
    expect(auditCsvCell('plain')).toBe('plain');
    expect(auditCsvCell(-5)).toBe('-5'); // numbers are not text
    expect(auditCsvCell(null)).toBe('');
  });
});
