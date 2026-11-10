import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXAM_SLUGS,
  FREE_EXAMS,
  LEVELS,
  allPoolItems,
  bandFor,
  drawSet,
  getExam,
  getSet,
  itemsPerAttempt,
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
    expect(APT.sets.hard.pool).toHaveLength(10);
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

  it('keeps the best per exam and set and ignores junk', () => {
    expect(saveBest('aptitude', 'easy', 60)).toEqual({ easy: 60 });
    expect(saveBest('aptitude', 'easy', 40).easy).toBe(60);
    expect(saveBest('aptitude', 'easy', 80).easy).toBe(80);
    expect(JSON.parse(window.localStorage.getItem('aiq-free-best')!)).toEqual({ aptitude: { easy: 80 } });
    expect(readBest('other')).toEqual({});
    window.localStorage.setItem('aiq-free-best', 'not json');
    expect(readBest('aptitude')).toEqual({});
  });

  it('reads the old aptitude key as aptitude scores and the higher value wins', () => {
    window.localStorage.setItem('aiq-free-aptitude-best', '{"easy":"x","hard":50,"medium":70,"bogus":1}');
    expect(readBest('aptitude')).toEqual({ medium: 70, hard: 50 });
    expect(readBest('other')).toEqual({});
    expect(saveBest('aptitude', 'hard', 90)).toEqual({ medium: 70, hard: 90 });
    expect(saveBest('aptitude', 'medium', 10).medium).toBe(70);
  });
});

// The free items are public. They must never equal an item of a real pack. Both files are gitignored, so
// CI skips this and the local run checks it. Covers every exam in the registry.
const ROOT = resolve(__dirname, '../../../../..');
const V2 = resolve(ROOT, 'docs/exam-content/Aptitude/aptitude-questions-v2.json');
const MERGED = resolve(ROOT, 'docs/private/aptitude-generator/out/assembled/merged.jsonl');

describe('free items do not overlap the real packs', () => {
  it.skipIf(!existsSync(V2))('no free stem equals a v2 stem', () => {
    const v2 = new Set(
      (JSON.parse(readFileSync(V2, 'utf8')) as { questions: { stem: string }[] }).questions.map((q) => norm(q.stem)),
    );
    const hits = allPoolItems().filter((i) => v2.has(norm(i.prompt))).map((i) => i.id);
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
