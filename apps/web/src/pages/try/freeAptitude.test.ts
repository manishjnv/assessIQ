import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FREE_SETS,
  FREE_SLUGS,
  MIX,
  SECTIONS,
  bandFor,
  drawSet,
  readBest,
  saveBest,
  sectionScores,
  shareText,
  weakestTopic,
  type PoolItem,
} from './freeAptitude';
import { scoreDemo } from './demoContent';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const allItems = (): PoolItem[] => FREE_SLUGS.flatMap((s) => FREE_SETS[s].pool);
const seq = (): (() => number) => {
  let i = 0;
  return () => ((i += 0.137) % 1);
};

describe('free aptitude content', () => {
  it('every item is well formed and unique', () => {
    const items = allItems();
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

  it('every set has enough items per section and the hard set is exactly 4/3/3', () => {
    for (const slug of FREE_SLUGS) {
      for (const s of SECTIONS) {
        expect(FREE_SETS[slug].pool.filter((i) => i.section === s).length).toBeGreaterThanOrEqual(MIX[s]);
      }
    }
    expect(FREE_SETS.hard.pool).toHaveLength(10);
    expect(FREE_SETS.easy.level).toBe(1);
    expect(FREE_SETS.medium.level).toBe(3);
    expect(FREE_SETS.hard.level).toBe(5);
  });

  it('a draw is 10 items at 4/3/3, all marked free_public, and draws differ', () => {
    for (const slug of FREE_SLUGS) {
      const q = drawSet(FREE_SETS[slug], seq());
      expect(q).toHaveLength(10);
      expect(q.every((x) => x.origin === 'free_public' && x.type === 'mcq' && x.points === 10)).toBe(true);
      for (const s of SECTIONS) expect(q.filter((x) => x.section === s)).toHaveLength(MIX[s]);
    }
    const a = drawSet(FREE_SETS.easy, () => 0.1).map((x) => x.id).join();
    const b = drawSet(FREE_SETS.easy, () => 0.9).map((x) => x.id).join();
    expect(a).not.toBe(b);
  });

  it('v1 items Q-045 and Q-050 are not used', () => {
    const ids = allItems().map((i) => i.id);
    expect(ids).not.toContain('e-045');
    expect(ids).not.toContain('e-050');
  });
});

describe('free aptitude scoring helpers', () => {
  const qs = drawSet(FREE_SETS.medium, seq());
  const answersAllRight = Object.fromEntries(qs.map((q) => [q.id, q.correct as number]));

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
    const none = scoreDemo(wrong, qs);
    expect(none.percent).toBe(0);
    expect(sectionScores(none.rows).map((s) => [s.section, s.percent])).toEqual([
      ['quant', 0],
      ['logical', 0],
      ['verbal', 0],
    ]);
    expect(weakestTopic(none.rows)).not.toBeNull();
    const all = scoreDemo(answersAllRight, qs);
    expect(all.percent).toBe(100);
    expect(weakestTopic(all.rows)).toBeNull();
  });

  it('share text has the score, the band, an emoji row and the landing link without any email', () => {
    const t = shareText(FREE_SETS.hard, [true, true, false, true, true, true, true, true, true, true], 700);
    expect(t).toContain('9/10 in 11:40 (Top scorer)');
    expect(t).toContain('🟩🟩🟥🟩🟩🟩🟩🟩🟩🟩');
    expect(t).toContain('https://assessiq.in/free-aptitude-test/hard?src=wa');
    expect(t).not.toContain('@');
  });
});

describe('best score storage', () => {
  afterEach(() => window.localStorage.clear());

  it('keeps the best per set and ignores junk', () => {
    expect(saveBest('easy', 60)).toEqual({ easy: 60 });
    expect(saveBest('easy', 40).easy).toBe(60);
    expect(saveBest('easy', 80).easy).toBe(80);
    window.localStorage.setItem('aiq-free-aptitude-best', '{"easy":"x","hard":50,"bogus":1}');
    expect(readBest()).toEqual({ hard: 50 });
    window.localStorage.setItem('aiq-free-aptitude-best', 'not json');
    expect(readBest()).toEqual({});
  });
});

// The free items are public. They must never equal an item of a real pack. Both files are gitignored, so
// CI skips this and the local run checks it.
const ROOT = resolve(__dirname, '../../../../..');
const V2 = resolve(ROOT, 'docs/exam-content/Aptitude/aptitude-questions-v2.json');
const MERGED = resolve(ROOT, 'docs/private/aptitude-generator/out/assembled/merged.jsonl');

describe('free items do not overlap the real packs', () => {
  it.skipIf(!existsSync(V2))('no free stem equals a v2 stem', () => {
    const v2 = new Set(
      (JSON.parse(readFileSync(V2, 'utf8')) as { questions: { stem: string }[] }).questions.map((q) => norm(q.stem)),
    );
    const hits = allItems().filter((i) => v2.has(norm(i.prompt))).map((i) => i.id);
    expect(hits).toEqual([]);
  });

  it.skipIf(!existsSync(MERGED))('no free stem equals a merged.jsonl stem and no hard item repeats a template and number set', () => {
    const stems = new Set<string>();
    const keys = new Set<string>();
    for (const line of readFileSync(MERGED, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { question?: string; template_id?: string; question_data?: { numbers?: number[] } };
      if (r.question) stems.add(norm(r.question));
      const nums = r.question_data?.numbers;
      if (r.template_id && Array.isArray(nums)) keys.add(`${r.template_id}|${[...nums].sort((a, b) => a - b).join(',')}`);
    }
    expect(allItems().filter((i) => stems.has(norm(i.prompt))).map((i) => i.id)).toEqual([]);
    const dup = FREE_SETS.hard.pool
      .filter((i) => i.tpl && i.nums && keys.has(`${i.tpl}|${[...i.nums].sort((a, b) => a - b).join(',')}`))
      .map((i) => i.id);
    expect(dup).toEqual([]);
  });
});
