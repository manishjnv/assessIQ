// REGISTRY of the free no-login tests: /try (exam picker) -> /try/:exam (level picker) -> /try/:exam/:set (test).
//
// HOW TO ADD AN EXAM (one data file + one registry entry + a marketing page, nothing else):
//   1. Create `free<Exam>.ts` next to this file. Export a `FreeExam` (see freeTypes.ts): slug, title, blurb and
//      `sets` for easy, medium and hard. Each set names its own `sections` (id, label, items drawn) and its pool.
//      Every item is public: never copy items from a platform pack (the overlap test checks every exam here).
//   2. Add the exam to FREE_EXAMS below.
//   3. Add the marketing landing page https://assessiq.in/free-<exam>-test/<set> (used for share links and canonical).
// The pickers, the runner, the result screen, best-score storage and the tests read this registry only.

import { APTITUDE } from './freeAptitude';
import type { FreeExam, FreeSet, Level, PoolItem } from './freeTypes';
import type { FreeQuestion } from './freeScoring';

export type { FreeExam, FreeSet, FreeSection, Level, PoolItem } from './freeTypes';

export const FREE_EXAMS: Record<string, FreeExam> = {
  [APTITUDE.slug]: APTITUDE,
};

export const EXAM_SLUGS = Object.keys(FREE_EXAMS);
export const LEVELS: Level[] = ['easy', 'medium', 'hard'];
export const POINTS_PER_ITEM = 10;
export const FREE_ORIGIN = 'free_public' as const;

export const getExam = (slug: string | undefined): FreeExam | null =>
  slug != null && Object.prototype.hasOwnProperty.call(FREE_EXAMS, slug) ? FREE_EXAMS[slug]! : null;

export const getSet = (exam: FreeExam | null, level: string | undefined): FreeSet | null =>
  exam != null && level != null && Object.prototype.hasOwnProperty.call(exam.sets, level) ? exam.sets[level as Level] : null;

export const allPoolItems = (): PoolItem[] => EXAM_SLUGS.flatMap((e) => LEVELS.flatMap((l) => FREE_EXAMS[e]!.sets[l].pool));

export const itemsPerAttempt = (set: FreeSet): number => set.sections.reduce((n, s) => n + s.count, 0);

/** Where the end button goes. true = SIGNUP_ENABLED is true on the API (checked on the VPS 2026-11-10); set false to send people to /contact. */
export const SIGNUP_OPEN = true;
export const END_HREF = SIGNUP_OPEN ? '/signup?src=try' : '/contact?src=try';

export const landingBase = (exam: string): string => `https://assessiq.in/free-${exam}-test`;
export const landingUrl = (set: FreeSet): string => `${landingBase(set.exam)}/${set.slug}`;

export function toFreeQuestion(it: PoolItem, sectionLabel: string): FreeQuestion {
  return {
    id: it.id,
    type: 'mcq',
    typeLabel: sectionLabel,
    prompt: it.prompt,
    options: it.options,
    correct: it.correct,
    points: POINTS_PER_ITEM,
    modelAnswer: it.options[it.correct]!,
    why: it.why,
    section: it.section,
    topic: it.topic,
    origin: FREE_ORIGIN,
  };
}

/** Random draw for one attempt: each section's `count` items (Fisher-Yates; `rng` is injectable for tests). */
export function drawSet(set: FreeSet, rng: () => number = Math.random): FreeQuestion[] {
  const out: FreeQuestion[] = [];
  for (const sec of set.sections) {
    const items = set.pool.filter((i) => i.section === sec.id);
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    for (const it of items.slice(0, sec.count)) out.push(toFreeQuestion(it, sec.label));
  }
  return out;
}

export function bandFor(percent: number): string {
  if (percent >= 90) return 'Top scorer';
  if (percent >= 70) return 'Placement-ready';
  if (percent >= 40) return 'Getting there';
  return 'Build the basics';
}

export interface SectionScore {
  section: string;
  label: string;
  earned: number;
  max: number;
  percent: number;
}

export function sectionScores(set: FreeSet, rows: { q: FreeQuestion; earned: number }[]): SectionScore[] {
  return set.sections
    .map((sec) => {
      const mine = rows.filter((r) => r.q.section === sec.id);
      const max = mine.reduce((s, r) => s + r.q.points, 0);
      const earned = mine.reduce((s, r) => s + r.earned, 0);
      return { section: sec.id, label: sec.label, earned, max, percent: max === 0 ? 0 : Math.round((earned / max) * 100) };
    })
    .filter((s) => s.max > 0);
}

/** Topic with the lowest score (ties: the first seen). Null when every topic is fully right. */
export function weakestTopic(rows: { q: FreeQuestion; earned: number }[]): string | null {
  const t = new Map<string, { earned: number; max: number }>();
  for (const r of rows) {
    const k = r.q.topic;
    if (!k) continue;
    const e = t.get(k) ?? { earned: 0, max: 0 };
    e.earned += r.earned;
    e.max += r.q.points;
    t.set(k, e);
  }
  let worst: string | null = null;
  let worstRatio = 1;
  for (const [k, v] of t) {
    const ratio = v.max === 0 ? 1 : v.earned / v.max;
    if (ratio < worstRatio) {
      worst = k;
      worstRatio = ratio;
    }
  }
  return worst;
}

export const formatTopic = (t: string): string => t.replace(/[_-]/g, ' ');

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One line on pace, from the accuracy and the share of the time limit used. */
export function paceLine(percent: number, usedSeconds: number, limitSeconds: number): string {
  const fast = usedSeconds <= limitSeconds * 0.6;
  if (fast && percent < 60) return 'Fast but careless: slow down and check each option.';
  if (!fast && percent >= 70) return 'Accurate but slow: practise speed on the topics you know.';
  if (fast && percent >= 70) return 'Fast and accurate.';
  return 'Pace is fine: work on accuracy.';
}

/** Plain text for WhatsApp: headline plus an emoji row (one square per item, in order) and the landing link. */
export function shareText(set: FreeSet, correctFlags: boolean[], usedSeconds: number): string {
  const right = correctFlags.filter(Boolean).length;
  const percent = Math.round((right / correctFlags.length) * 100);
  const grid = correctFlags.map((ok) => (ok ? '🟩' : '🟥')).join('');
  const exam = getExam(set.exam)?.title.toLowerCase() ?? set.exam;
  return `AssessIQ ${set.title} ${exam} test: ${right}/${correctFlags.length} in ${formatClock(usedSeconds)} (${bandFor(percent)})\n${grid}\nTry it free, no login: ${landingUrl(set)}?src=wa`;
}

export const whatsappLink = (text: string): string => `https://wa.me/?text=${encodeURIComponent(text)}`;

// Best score per exam and set stays in this browser only. localStorage can be blocked: every access is try/catch.
// Shape: { [exam]: { easy?, medium?, hard? } }. The old key 'aiq-free-aptitude-best' held the aptitude scores flat.

const BEST_KEY = 'aiq-free-best';
const LEGACY_APTITUDE_KEY = 'aiq-free-aptitude-best';
export type BestScores = Partial<Record<Level, number>>;

const pick = (v: unknown): BestScores => {
  const out: BestScores = {};
  if (v == null || typeof v !== 'object') return out;
  for (const l of LEVELS) {
    const n = (v as Record<string, unknown>)[l];
    if (typeof n === 'number' && Number.isFinite(n)) out[l] = n;
  }
  return out;
};

const readJson = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function readBest(exam: string): BestScores {
  const cur = readJson(BEST_KEY);
  const mine = cur != null && typeof cur === 'object' ? pick((cur as Record<string, unknown>)[exam]) : {};
  if (exam !== 'aptitude') return mine;
  const out = pick(readJson(LEGACY_APTITUDE_KEY));
  for (const l of LEVELS) if (mine[l] != null && (out[l] == null || mine[l]! > out[l]!)) out[l] = mine[l]!;
  return out;
}

export function saveBest(exam: string, level: Level, percent: number): BestScores {
  const mine = readBest(exam);
  if (mine[level] == null || percent > mine[level]!) mine[level] = percent;
  try {
    const cur = readJson(BEST_KEY);
    const all = cur != null && typeof cur === 'object' ? { ...(cur as Record<string, unknown>) } : {};
    all[exam] = mine;
    window.localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* blocked storage: the score is just not remembered */
  }
  return mine;
}
