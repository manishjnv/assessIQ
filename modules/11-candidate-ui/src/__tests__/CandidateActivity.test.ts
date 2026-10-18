// Tests for the candidate Activity quartile wording (Z-15 (f)).
// The labels must match the admin Activity page (RW-21): plain words, no "quartile".

import { describe, expect, it } from 'vitest';
import { quartileBreakdown } from '../components/CandidateActivity';

describe('CandidateActivity quartile labels (Z-15 f)', () => {
  it('uses the admin Activity wording for each band', () => {
    const out = quartileBreakdown([
      { key: 'top_quartile', value: 1, pct: 10 },
      { key: 'above_median', value: 2, pct: 20 },
      { key: 'below_median', value: 3, pct: 30 },
      { key: 'bottom_quartile', value: 4, pct: 40 },
    ]);
    expect(out.map((i) => i.label)).toEqual(['Top 25%', 'Upper middle', 'Lower middle', 'Bottom 25%']);
    expect(out.map((i) => i.value)).toEqual([1, 2, 3, 4]);
  });

  it('never shows the old quartile or median words', () => {
    const labels = quartileBreakdown([
      { key: 'top_quartile', value: 0, pct: 0 },
      { key: 'bottom_quartile', value: 0, pct: 0 },
    ]).map((i) => i.label).join(' ');
    expect(labels).not.toMatch(/quartile|median/i);
  });
});
