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
import type { FreeExam, FreeSet, Level, Mode, PoolItem } from './freeTypes';
import type { FreeQuestion } from './freeScoring';

export type { FreeExam, FreeSet, FreeSection, Level, Mode, PoolItem } from './freeTypes';

export const ALL_MODES: Mode[] = ['mock', 'real'];
/** The two modes of a free test. Real is without camera: organisations add a camera in their own assessments. */
export const FREE_MODES: Record<Mode, { label: string; subtitle: string }> = {
  mock: { label: 'Mock', subtitle: 'answers and explanations at the end' },
  real: { label: 'Real', subtitle: 'real-exam mode, practice copy' },
};
/** ?mode= value to a Mode. Absent, unknown or not offered by the exam = mock. */
export const parseMode = (raw: string | null, allowed: Mode[] = ALL_MODES): Mode => (raw === 'real' && allowed.includes('real') ? 'real' : 'mock');

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
export const endHref = (mode: Mode): string => `${SIGNUP_OPEN ? '/signup' : '/contact'}?src=${mode === 'real' ? 'try-real' : 'try'}`;

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

// Seen list: ids drawn in earlier attempts, so a returning visitor gets fresh items until the pool is used up.
// Shape: { [exam]: { [level]: string[] } }. Blocked storage = plain random draw.
const SEEN_KEY = 'aiq-free-seen';

export function readSeen(exam: string, level: Level): string[] {
  const all = readJson(SEEN_KEY);
  const v = all != null && typeof all === 'object' ? (all as Record<string, unknown>)[exam] : null;
  const ids = v != null && typeof v === 'object' ? (v as Record<string, unknown>)[level] : null;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

export function saveSeen(exam: string, level: Level, ids: string[]): void {
  try {
    const all = readJson(SEEN_KEY);
    const next = all != null && typeof all === 'object' ? { ...(all as Record<string, unknown>) } : {};
    const mine = next[exam] != null && typeof next[exam] === 'object' ? { ...(next[exam] as Record<string, unknown>) } : {};
    mine[level] = ids;
    next[exam] = mine;
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* blocked storage: the draw is just not remembered */
  }
}

/** Items of one section for this attempt: unseen first (reset when too few), shuffled, distinct topics preferred. */
function pickSection(items: PoolItem[], count: number, seen: Set<string>, rng: () => number): PoolItem[] {
  let items2 = items.filter((i) => !seen.has(i.id));
  if (items2.length < count) items2 = [...items];
  for (let i = items2.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items2[i], items2[j]] = [items2[j]!, items2[i]!];
  }
  const picks = items2.slice(0, count);
  const rest = items2.slice(count);
  for (let k = 0; k < picks.length; k++) {
    if (picks.findIndex((p) => p.topic === picks[k]!.topic) === k) continue;
    const r = rest.findIndex((c) => !picks.some((p) => p.topic === c.topic));
    if (r >= 0) [picks[k], rest[r]] = [rest[r]!, picks[k]!];
  }
  return picks;
}

/** Random draw for one attempt: each section's `count` items (`rng` is injectable for tests; `seen` = ids from earlier attempts). */
export function drawSet(set: FreeSet, rng: () => number = Math.random, seen: string[] = []): FreeQuestion[] {
  const s = new Set(seen);
  return set.sections.flatMap((sec) =>
    pickSection(
      set.pool.filter((i) => i.section === sec.id),
      sec.count,
      s,
      rng,
    ).map((it) => toFreeQuestion(it, sec.label)),
  );
}

/** The seen list after a draw: a section that ran short starts over, drawn ids are added, length capped to the pool size. */
export function nextSeen(set: FreeSet, seen: string[], drawn: FreeQuestion[]): string[] {
  const s = new Set(seen);
  for (const sec of set.sections) {
    const ids = set.pool.filter((i) => i.section === sec.id).map((i) => i.id);
    if (ids.filter((id) => !s.has(id)).length < sec.count) ids.forEach((id) => s.delete(id));
  }
  const poolIds = new Set(set.pool.map((i) => i.id));
  const out = [...s].filter((id) => poolIds.has(id));
  for (const q of drawn) out.push(q.id);
  return out.slice(-set.pool.length);
}

/** Draw for a real attempt: reads the seen list, draws, saves the new list. Call at test start, not at render. */
export function drawAndRemember(set: FreeSet): FreeQuestion[] {
  const seen = readSeen(set.exam, set.slug);
  const q = drawSet(set, Math.random, seen);
  saveSeen(set.exam, set.slug, nextSeen(set, seen, q));
  return q;
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
export function shareText(set: FreeSet, correctFlags: boolean[], usedSeconds: number, mode: Mode = 'mock'): string {
  const right = correctFlags.filter(Boolean).length;
  const percent = Math.round((right / correctFlags.length) * 100);
  const grid = correctFlags.map((ok) => (ok ? '🟩' : '🟥')).join('');
  const exam = getExam(set.exam)?.title.toLowerCase() ?? set.exam;
  const kind = mode === 'real' ? `${exam} test, Real mode` : `${exam} test`;
  return `AssessIQ ${set.title} ${kind}: ${right}/${correctFlags.length} in ${formatClock(usedSeconds)} (${bandFor(percent)})\n${grid}\nTry it free, no login: ${landingUrl(set)}?src=wa`;
}

export const whatsappLink = (text: string): string => `https://wa.me/?text=${encodeURIComponent(text)}`;

// Best score per exam, level and mode stays in this browser only. localStorage can be blocked: every access is try/catch.
// Shape: { [exam]: { [level]: { mock?, real? } } }. Old shapes still read: a bare number at [exam][level] is a mock
// score, and the old key 'aiq-free-aptitude-best' held flat aptitude mock scores.

const BEST_KEY = 'aiq-free-best';
const LEGACY_APTITUDE_KEY = 'aiq-free-aptitude-best';
export type ModeBest = Partial<Record<Mode, number>>;
export type BestScores = Partial<Record<Level, ModeBest>>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const pick = (v: unknown): BestScores => {
  const out: BestScores = {};
  if (v == null || typeof v !== 'object') return out;
  for (const l of LEVELS) {
    const raw = (v as Record<string, unknown>)[l];
    const mb: ModeBest = {};
    const bare = num(raw);
    if (bare != null) mb.mock = bare;
    else if (raw != null && typeof raw === 'object') {
      for (const m of ALL_MODES) {
        const n = num((raw as Record<string, unknown>)[m]);
        if (n != null) mb[m] = n;
      }
    }
    if (Object.keys(mb).length > 0) out[l] = mb;
  }
  return out;
};

const merge = (a: BestScores, b: BestScores): BestScores => {
  const out: BestScores = {};
  for (const l of LEVELS) {
    const mb: ModeBest = {};
    for (const m of ALL_MODES) {
      const x = a[l]?.[m];
      const y = b[l]?.[m];
      if (x != null || y != null) mb[m] = Math.max(x ?? 0, y ?? 0);
    }
    if (Object.keys(mb).length > 0) out[l] = mb;
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
  return exam === 'aptitude' ? merge(mine, pick(readJson(LEGACY_APTITUDE_KEY))) : mine;
}

/** "Mock 80% · Real 60%" for the modes tried, or null when none. */
export function bestLine(b: ModeBest | undefined): string | null {
  const parts = ALL_MODES.filter((m) => b?.[m] != null).map((m) => `${FREE_MODES[m].label} ${b![m]}%`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function saveBest(exam: string, level: Level, mode: Mode, percent: number): BestScores {
  const mine = readBest(exam);
  const mb: ModeBest = { ...mine[level] };
  if (mb[mode] == null || percent > mb[mode]!) mb[mode] = percent;
  mine[level] = mb;
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
