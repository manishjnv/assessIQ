// Types of the free no-login tests. Kept apart from the registry so exam data files can import them without a cycle.

export type Level = 'easy' | 'medium' | 'hard';

/** Mock: answers and explanations at the end. Real: same screen as a real assessment, answers behind one click. No camera in either. */
export type Mode = 'mock' | 'real';

/** One section of a set: `count` items are drawn from the pool items whose `section` equals `id`. */
export interface FreeSection {
  id: string;
  label: string;
  count: number;
}

export interface PoolItem {
  id: string;
  /** A FreeSection id of the set. */
  section: string;
  topic: string;
  prompt: string;
  options: string[];
  correct: number;
  why: string;
  /** Engine items only: template id and the numbers of the stem (the overlap test compares them with the real pool). */
  tpl?: string;
  nums?: number[];
}

export interface FreeSet {
  /** Exam slug (key of FREE_EXAMS). */
  exam: string;
  slug: Level;
  title: string;
  minutes: number;
  /** Platform difficulty level (easy 1, medium 3, hard 5). */
  level: 1 | 3 | 5;
  /** The mix of one attempt. Lives on the set so each exam can have its own sections. */
  sections: FreeSection[];
  pool: PoolItem[];
}

export interface FreeExam {
  slug: string;
  title: string;
  blurb: string;
  /** Modes the exam offers. Default: both. */
  modes?: Mode[];
  sets: Record<Level, FreeSet>;
}
