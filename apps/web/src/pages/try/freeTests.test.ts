import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXAM_SLUGS,
  FREE_EXAMS,
  LEVELS,
  allPoolItems,
  bandFor,
  drawSet,
  drawAndRemember,
  readSeen,
  saveSeen,
  getExam,
  getSet,
  itemsPerAttempt,
  bestLine,
  parseMode,
  readBest,
  saveBest,
  sectionScores,
  shareText,
  weakestTopic,
} from './freeTests';
import { fractionFor, scoreFree } from './freeScoring';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const seq = (): (() => number) => {
  let i = 0;
  return () => ((i += 0.137) % 1);
};
const APT = FREE_EXAMS['aptitude']!;
const sets = () => EXAM_SLUGS.flatMap((e) => LEVELS.map((l) => FREE_EXAMS[e]!.sets[l]));

describe('registry', () => {
  it('lists aptitude only, each exam has easy, medium and hard sets that name their exam', () => {
    expect(EXAM_SLUGS).toEqual(['aptitude']);
    for (const e of EXAM_SLUGS) {
      const exam = FREE_EXAMS[e]!;
      expect(exam.slug).toBe(e);
      expect(exam.title.length).toBeGreaterThan(0);
      for (const l of LEVELS) {
        expect(exam.sets[l].exam).toBe(e);
        expect(exam.sets[l].slug).toBe(l);
      }
    }
    expect(getExam('nope')).toBeNull();
    expect(getExam('toString')).toBeNull();
    expect(getSet(APT, 'hard')?.slug).toBe('hard');
    expect(getSet(APT, 'nope')).toBeNull();
    expect(getSet(null, 'easy')).toBeNull();
  });

  it('every item is well formed and unique', () => {
    const items = allPoolItems();
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => norm(i.prompt))).size).toBe(items.length);
    for (const i of items) {
      expect(i.options).toHaveLength(4);
      expect(new Set(i.options).size).toBe(4);
      expect(i.correct).toBeGreaterThanOrEqual(0);
      expect(i.correct).toBeLessThanOrEqual(3);
      expect(i.why.length).toBeGreaterThan(10);
      expect(i.topic.length).toBeGreaterThan(0);
    }
  });

  it('every set has enough items for each of its own sections; aptitude is 4/3/3 and levels are 1/3/5', () => {
    for (const set of sets()) {
      for (const sec of set.sections) {
        expect(set.pool.filter((i) => i.section === sec.id).length).toBeGreaterThanOrEqual(sec.count);
      }
      expect(set.pool.every((i) => set.sections.some((s) => s.id === i.section))).toBe(true);
    }
    expect(APT.sets.easy.sections.map((s) => s.count)).toEqual([4, 3, 3]);
    expect(itemsPerAttempt(APT.sets.hard)).toBe(10);
    expect([APT.sets.easy.minutes, APT.sets.medium.minutes, APT.sets.hard.minutes]).toEqual([8, 12, 20]);
    expect([APT.sets.easy.level, APT.sets.medium.level, APT.sets.hard.level]).toEqual([1, 3, 5]);
  });

  it('a draw follows the set mix, all items marked free_public, and draws differ', () => {
    for (const set of sets()) {
      const q = drawSet(set, seq());
      expect(q).toHaveLength(itemsPerAttempt(set));
      expect(q.every((x) => x.origin === 'free_public' && x.type === 'mcq' && x.points === 10)).toBe(true);
      for (const sec of set.sections) expect(q.filter((x) => x.section === sec.id)).toHaveLength(sec.count);
    }
    const a = drawSet(APT.sets.easy, () => 0.1).map((x) => x.id).join();
    const b = drawSet(APT.sets.easy, () => 0.9).map((x) => x.id).join();
    expect(a).not.toBe(b);
  });

  it('v1 items Q-045 and Q-050 are not used', () => {
    const ids = allPoolItems().map((i) => i.id);
    expect(ids).not.toContain('e-045');
    expect(ids).not.toContain('e-050');
  });
});

describe('scoring helpers', () => {
  const set = APT.sets.medium;
  const qs = drawSet(set, seq());

  it('mcq scoring is exact index', () => {
    expect(fractionFor(qs[0]!, qs[0]!.correct as number)).toBe(1);
    expect(fractionFor(qs[0]!, ((qs[0]!.correct as number) + 1) % 4)).toBe(0);
    expect(fractionFor(qs[0]!, null)).toBe(0);
  });

  it('band thresholds', () => {
    expect([0, 39, 40, 69, 70, 89, 90, 100].map(bandFor)).toEqual([
      'Build the basics',
      'Build the basics',
      'Getting there',
      'Getting there',
      'Placement-ready',
      'Placement-ready',
      'Top scorer',
      'Top scorer',
    ]);
  });

  it('section scores and weakest topic', () => {
    const wrong = Object.fromEntries(qs.map((q) => [q.id, ((q.correct as number) + 1) % 4]));
    const none = scoreFree(wrong, qs);
    expect(none.percent).toBe(0);
    expect(sectionScores(set, none.rows).map((s) => [s.section, s.label, s.percent])).toEqual([
      ['quant', 'Quantitative', 0],
      ['logical', 'Logical', 0],
      ['verbal', 'Verbal', 0],
    ]);
    expect(weakestTopic(none.rows)).not.toBeNull();
    const all = scoreFree(Object.fromEntries(qs.map((q) => [q.id, q.correct as number])), qs);
    expect(all.percent).toBe(100);
    expect(weakestTopic(all.rows)).toBeNull();
  });

  it('share text has the score, the band, an emoji row and the exam landing link without any email', () => {
    const t = shareText(APT.sets.hard, [true, true, false, true, true, true, true, true, true, true], 700);
    expect(t).toContain('AssessIQ Top scorer aptitude test: 9/10 in 11:40 (Top scorer)');
    expect(t).toContain('🟩🟩🟥🟩🟩🟩🟩🟩🟩🟩');
    expect(t).toContain('https://assessiq.in/free-aptitude-test/hard?src=wa');
    expect(t).not.toContain('@');
  });
});

describe('best score storage', () => {
  afterEach(() => window.localStorage.clear());

  it('keeps the best per exam, level and mode in the new shape and ignores junk', () => {
    expect(saveBest('aptitude', 'easy', 'mock', 60)).toEqual({ easy: { mock: 60 } });
    expect(saveBest('aptitude', 'easy', 'mock', 40).easy).toEqual({ mock: 60 });
    expect(saveBest('aptitude', 'easy', 'mock', 80).easy).toEqual({ mock: 80 });
    expect(saveBest('aptitude', 'easy', 'real', 50).easy).toEqual({ mock: 80, real: 50 });
    expect(JSON.parse(window.localStorage.getItem('aiq-free-best')!)).toEqual({ aptitude: { easy: { mock: 80, real: 50 } } });
    expect(readBest('other')).toEqual({});
    window.localStorage.setItem('aiq-free-best', 'not json');
    expect(readBest('aptitude')).toEqual({});
  });

  it('a bare number at [exam][level] (previous shape) reads as mock', () => {
    window.localStorage.setItem('aiq-free-best', '{"aptitude":{"easy":90,"hard":{"real":70}}}');
    expect(readBest('aptitude')).toEqual({ easy: { mock: 90 }, hard: { real: 70 } });
    expect(saveBest('aptitude', 'easy', 'real', 30).easy).toEqual({ mock: 90, real: 30 });
  });

  it('reads the old aptitude key as mock scores and the higher value wins', () => {
    window.localStorage.setItem('aiq-free-aptitude-best', '{"easy":"x","hard":50,"medium":70,"bogus":1}');
    expect(readBest('aptitude')).toEqual({ medium: { mock: 70 }, hard: { mock: 50 } });
    expect(readBest('other')).toEqual({});
    expect(saveBest('aptitude', 'hard', 'mock', 90)).toEqual({ medium: { mock: 70 }, hard: { mock: 90 } });
    expect(saveBest('aptitude', 'medium', 'mock', 10).medium).toEqual({ mock: 70 });
  });

  it('bestLine and parseMode', () => {
    expect(bestLine({ mock: 80, real: 60 })).toBe('Mock 80% · Real 60%');
    expect(bestLine(undefined)).toBeNull();
    expect(parseMode('real')).toBe('real');
    expect(parseMode('REAL')).toBe('mock');
    expect(parseMode(null)).toBe('mock');
    expect(parseMode('real', ['mock'])).toBe('mock');
  });

  it('share text names Real mode', () => {
    const t = shareText(APT.sets.easy, [true, false], 492, 'real');
    expect(t).toContain('AssessIQ Warm-up aptitude test, Real mode: 1/2 in 8:12');
  });
});

// The free items are public. They must never equal an item of a real pack. Both files are gitignored, so
// CI skips this and the local run checks it. Covers every exam in the registry.
const ROOT = resolve(__dirname, '../../../../..');
const VERBAL = resolve(ROOT, 'docs/private/aptitude-generator/out/load/verbal-01.csv');
const MERGED = resolve(ROOT, 'docs/private/aptitude-generator/out/assembled/merged.jsonl');

describe('free items do not overlap the real packs', () => {
  // v2 items are allowed in the free pool (owner decision: they go public), so there is no v2 check.
  // CSV with quoted fields; column indexes come from the header. Handles "" and newlines inside quotes.
  const parseCsv = (txt: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let f = '';
    let q = false;
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i]!;
      if (q) {
        if (c === '"' && txt[i + 1] === '"') {
          f += '"';
          i++;
        } else if (c === '"') q = false;
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        row.push(f);
        f = '';
      } else if (c === '\n') {
        row.push(f.replace(/\r$/, ''));
        rows.push(row);
        row = [];
        f = '';
      } else f += c;
    }
    if (f || row.length) {
      row.push(f);
      rows.push(row);
    }
    return rows;
  };

  it.skipIf(!existsSync(VERBAL))('no free stem equals a verbal-01.csv stem and no free verbal key equals a real verbal key', () => {
    const rows = parseCsv(readFileSync(VERBAL, 'utf8'));
    const h = rows[0]!;
    const [qi, oi, ci] = [h.indexOf('question'), h.indexOf('options'), h.indexOf('correct')];
    expect(qi).toBeGreaterThan(-1);
    const real = rows.slice(1).filter((r) => r[qi]);
    const stems = new Set(real.map((r) => norm(r[qi]!)));
    const items = allPoolItems();
    expect(items.filter((i) => stems.has(norm(i.prompt))).map((i) => i.id)).toEqual([]);
    // key text under the same stem (a bare key word like "sell" repeats legitimately across questions)
    const keys = new Set<string>();
    for (const r of real) {
      try {
        keys.add(norm(`${r[qi]}|${(JSON.parse(r[oi]!) as string[])[Number(r[ci])]}`));
      } catch {
        /* malformed row: skip */
      }
    }
    const hits = items.filter((i) => i.section === 'verbal' && keys.has(norm(`${i.prompt}|${i.options[i.correct]}`))).map((i) => i.id);
    expect(hits).toEqual([]);
  });

  it.skipIf(!existsSync(MERGED))('no free stem equals a merged.jsonl stem and no engine item repeats a template and number set', () => {
    const stems = new Set<string>();
    const keys = new Set<string>();
    for (const line of readFileSync(MERGED, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { question?: string; template_id?: string; question_data?: { numbers?: number[] } };
      if (r.question) stems.add(norm(r.question));
      const nums = r.question_data?.numbers;
      if (r.template_id && Array.isArray(nums)) keys.add(`${r.template_id}|${[...nums].sort((a, b) => a - b).join(',')}`);
    }
    const items = allPoolItems();
    expect(items.filter((i) => stems.has(norm(i.prompt))).map((i) => i.id)).toEqual([]);
    const dup = items
      .filter((i) => i.tpl && i.nums && keys.has(`${i.tpl}|${[...i.nums].sort((a, b) => a - b).join(',')}`))
      .map((i) => i.id);
    expect(dup).toEqual([]);
  });
});

describe('pool shape and seen-list draw', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  const KEYS = ['id', 'section', 'topic', 'prompt', 'options', 'correct', 'why', 'tpl', 'nums'];

  it('each level and section pool covers its draw count and has enough topics', () => {
    for (const set of sets()) {
      for (const sec of set.sections) {
        const items = set.pool.filter((i) => i.section === sec.id);
        expect(items.length).toBeGreaterThanOrEqual(sec.count);
        expect(new Set(items.map((i) => i.topic)).size).toBeGreaterThanOrEqual(sec.count);
      }
    }
  });

  it('no option index holds more than 35% of keys per level (pools of 30 or more)', () => {
    for (const set of sets()) {
      if (set.pool.length < 30) continue;
      for (let k = 0; k < 4; k++) expect(set.pool.filter((i) => i.correct === k).length / set.pool.length).toBeLessThanOrEqual(0.35);
    }
  });

  it('items carry only the allowed keys; ids and stems are unique across levels', () => {
    const items = allPoolItems();
    for (const i of items) expect(Object.keys(i).filter((k) => !KEYS.includes(k))).toEqual([]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => norm(i.prompt))).size).toBe(items.length);
  });

  it('four draws with a persisted seen list give 40 distinct ids when each section pool holds 4 draws', () => {
    for (const set of sets()) {
      if (set.sections.some((s) => set.pool.filter((i) => i.section === s.id).length < s.count * 4)) continue;
      const ids: string[] = [];
      for (let n = 0; n < 4; n++) ids.push(...drawAndRemember(set).map((q) => q.id));
      expect(new Set(ids).size).toBe(40);
      window.localStorage.clear();
    }
  });

  it('a draw picks distinct topics inside a section whenever the pool allows', () => {
    for (const set of sets()) {
      for (let n = 0; n < 20; n++) {
        const q = drawSet(set, seq());
        for (const sec of set.sections) {
          const topics = q.filter((x) => x.section === sec.id).map((x) => x.topic);
          expect(new Set(topics).size).toBe(topics.length);
        }
      }
    }
  });

  it('seen ids are skipped, unknown ids are ignored, and a used-up pool resets', () => {
    const set = APT.sets.easy;
    const first = drawSet(set, seq()).map((q) => q.id);
    const next = drawSet(set, seq(), [...first, 'gone-1']).map((q) => q.id);
    for (const sec of set.sections) {
      const mine = new Set(set.pool.filter((i) => i.section === sec.id).map((i) => i.id));
      if (mine.size - sec.count >= sec.count) expect(next.filter((id) => mine.has(id) && first.includes(id))).toEqual([]);
    }
    expect(drawSet(set, seq(), set.pool.map((i) => i.id))).toHaveLength(itemsPerAttempt(set));
  });

  it('one attempt saves its drawn ids; blocked storage still draws', () => {
    const set = APT.sets.medium;
    const q = drawAndRemember(set);
    expect(readSeen('aptitude', 'medium').sort()).toEqual(q.map((x) => x.id).sort());
    saveSeen('aptitude', 'easy', ['x']);
    expect(readSeen('aptitude', 'easy')).toEqual(['x']);
    expect(readSeen('aptitude', 'medium')).toHaveLength(itemsPerAttempt(set));

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSeen('aptitude', 'hard')).toEqual([]);
    expect(drawAndRemember(APT.sets.hard)).toHaveLength(itemsPerAttempt(APT.sets.hard));
  });
});
