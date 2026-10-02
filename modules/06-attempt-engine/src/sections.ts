/**
 * Test sections — pure timing helpers (no DB, no clock reads).
 *
 * A sectioned attempt has ONE running section at a time. Its deadline is
 * `started_at + minutes`. When the deadline passes, the next section opens at the
 * PREVIOUS DEADLINE (not "now"): a candidate who was away loses that time, and
 * the result is the same whether the server notices at once or on the next read.
 * "Finish section" is the only way a section opens earlier than that.
 */

import { AssessmentSectionsSchema } from "../../05-assessment-lifecycle/src/types.js";
import type { AssessmentSection } from "../../05-assessment-lifecycle/src/types.js";

export type { AssessmentSection };

export interface SectionPosition {
  current: number;
  startedAt: Date;
}

/** Sections from assessments.settings, or null when the assessment has none (or they are malformed). */
export function readSections(settings: unknown): AssessmentSection[] | null {
  const raw = (settings as { sections?: unknown } | null | undefined)?.sections;
  if (raw === undefined) return null;
  const r = AssessmentSectionsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Whole-test length in seconds = sum of the section minutes. */
export function totalSectionSeconds(sections: readonly AssessmentSection[], from = 0): number {
  return sections.slice(from).reduce((n, s) => n + s.minutes * 60, 0);
}

/**
 * Where the candidate is at `now`. Returns null when every section has ended
 * (the attempt is over). `stored` null = section 0 since `attemptStartedAt`.
 */
export function resolveSection(
  sections: readonly AssessmentSection[],
  stored: { current: number; started_at: string } | null,
  attemptStartedAt: Date,
  now: Date,
): SectionPosition | null {
  let current = stored?.current ?? 0;
  let startedAt = stored !== null ? new Date(stored.started_at) : attemptStartedAt;
  while (current < sections.length) {
    const deadline = startedAt.getTime() + (sections[current] as AssessmentSection).minutes * 60_000;
    if (deadline > now.getTime()) return { current, startedAt };
    startedAt = new Date(deadline);
    current += 1;
  }
  return null;
}

export interface SectionSummaryItem {
  index: number;
  name: string;
  question_count: number;
  answered_count: number;
  status: "done" | "current" | "upcoming";
}

/** Same emptiness rule as the take page (null / '' / [] / all-empty object = unanswered). */
export function isAnsweredValue(ans: unknown): boolean {
  const empty = (v: unknown): boolean =>
    v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty(ans)) return false;
  if (typeof ans === "object" && !Array.isArray(ans)) {
    return Object.values(ans as Record<string, unknown>).some((v) => !empty(v));
  }
  return true;
}

/**
 * Counts only per section (never question ids or content). `questions` = every frozen
 * question of the attempt (section_index + id), `answers` = saved answers by question id.
 */
export function buildSectionsSummary(
  sections: readonly AssessmentSection[],
  current: number,
  questions: ReadonlyArray<{ question_id: string; section_index?: number | null }>,
  answers: ReadonlyArray<{ question_id: string; answer: unknown }>,
): SectionSummaryItem[] {
  const answered = new Set(answers.filter((a) => isAnsweredValue(a.answer)).map((a) => a.question_id));
  return sections.map((s, index) => {
    const qs = questions.filter((q) => q.section_index === index);
    return {
      index,
      name: s.name,
      question_count: qs.length,
      answered_count: qs.filter((q) => answered.has(q.question_id)).length,
      status: index < current ? "done" : index === current ? "current" : "upcoming",
    };
  });
}

export function sectionDeadline(sections: readonly AssessmentSection[], pos: SectionPosition): Date {
  return new Date(pos.startedAt.getTime() + (sections[pos.current] as AssessmentSection).minutes * 60_000);
}
