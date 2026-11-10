// Question shape and deterministic client-side scoring for the public free tests (/try/:exam/:set).
// NOTHING here touches the network. Scoring goes through the @assessiq/question-types registry.
// (This file held the old 7-question demo too; that content was purged 2026-11-10, see Try.tsx.)

import { deterministicScoreFor, getQuestionType, isDeterministicType, type QuestionType } from '@assessiq/question-types';

export type FreeType = Extract<QuestionType, 'mcq' | 'numeric' | 'multi_select' | 'subjective'>;

export interface FreeQuestion {
  id: string;
  type: FreeType;
  /** Human label for the type chip (the section label for a free test). */
  typeLabel: string;
  prompt: string;
  options?: string[];
  unit?: string;
  /** mcq: option index. multi_select: option indexes. numeric: the number. */
  correct?: number | number[];
  tolerance?: number;
  partial?: boolean;
  points: number;
  modelAnswer: string;
  why?: string;
  /** Section id and topic feed the section bars and the weakest topic. */
  section?: string;
  topic?: string;
  /** 'free_public' marks a public item that must never be imported into a platform pack. */
  origin?: 'free_public';
}

export type FreeAnswer = number | number[] | string | null | undefined;
export type FreeAnswers = Record<string, FreeAnswer>;

export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 0..1 fraction of the question's points earned. */
export function fractionFor(q: FreeQuestion, a: FreeAnswer): number {
  if (a == null) return 0;
  const content = { options: q.options, correct: q.correct, answer: q.correct, tolerance: q.tolerance, scoring: q.partial ? 'partial' : 'all_or_nothing' };
  return deterministicScoreFor(q.type, content, a);
}

export function isAnswered(a: FreeAnswer): boolean {
  return a != null && a !== '' && !(Array.isArray(a) && a.length === 0);
}

export interface ScoreResult {
  earned: number;
  max: number;
  percent: number;
  rows: { q: FreeQuestion; earned: number; answered: boolean }[];
}

export function scoreFree(answers: FreeAnswers, questions: FreeQuestion[]): ScoreResult {
  const rows = questions.map((q) => {
    const a = answers[q.id];
    return { q, earned: Math.round(fractionFor(q, a) * q.points * 100) / 100, answered: isAnswered(a) };
  });
  const max = questions.reduce((s, q) => s + q.points, 0);
  const earned = Math.round(rows.reduce((s, r) => s + r.earned, 0) * 100) / 100;
  const percent = max === 0 ? 0 : Math.round((earned / max) * 1000) / 10;
  return { earned, max, percent, rows };
}

/** Readable form of the candidate's answer for the breakdown. */
export function describeAnswer(q: FreeQuestion, a: FreeAnswer): string {
  if (!isAnswered(a)) return 'Not answered';
  if (!isDeterministicType(q.type)) return String(a);
  if (getQuestionType(q.type).shuffleField !== 'options') return `${a}${q.unit ? ' ' + q.unit : ''}`;
  const opts = q.options ?? [];
  if (Array.isArray(a)) return a.map((i) => opts[i]).join(', ');
  return opts[a as number] ?? 'Not answered';
}
