// CT-2: the ONE place that turns "what the admin picked" into assessment fields.
// Three covers: the whole set, chosen topics (one count each) and an exam pattern. The Create a test page calls it through
// POST /api/admin/tests; the older full-mock route (mock.ts) and the topic drill (drill.ts) share its section builders, so a
// pattern or a topic list is turned into sections in exactly one way. Pure: no database, no clock.
import { ValidationError } from "@assessiq/core";
import type { ExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";
import { MAX_QUESTIONS_PER_ASSESSMENT, type AssessmentSection } from "../types.js";
import { buildTopicSections } from "./drill.js";

export type TestCover =
  | { kind: "whole"; question_count: number }
  | { kind: "topics"; topics: Array<{ node_id: string; count: number }> }
  | { kind: "pattern"; blueprint_id: string; section_positions?: number[] | undefined; scale_percent?: number | undefined; question_count?: number | undefined };

export interface CompileTestInput {
  cover: TestCover;
  /** Time limit in minutes (whole set and topics). A pattern keeps its own timing. */
  minutes?: number;
  difficulty_min?: number;
  difficulty_max?: number;
  /** Real topic names by node id (topics cover). */
  topicNames?: ReadonlyMap<string, string>;
  /** The pattern, already loaded (pattern cover). */
  blueprint?: ExamBlueprint;
  /** The admin's own name; absent = a default from the cover. */
  name?: string;
  /** Platform-side date label, only used in the default name. */
  today?: string;
}

export interface CompiledTest {
  name: string;
  question_count: number;
  /** Assessment time limit column (whole-set cover only). */
  duration_minutes?: number;
  /** Merged into assessments.settings next to the type-card settings. */
  settings: {
    sections?: AssessmentSection[];
    whole_test_minutes?: number;
    drill?: boolean;
    exam_blueprint?: { id: string; edition: string; verification_status: string };
  };
  warnings: string[];
}

const bad = (message: string, param: string): ValidationError => new ValidationError(message, { details: { code: "INVALID_PARAM", param } });

/**
 * Sections of an exam pattern. A short mock (some sections and/or a smaller size) keeps marks per question, drops cut-offs
 * and qualifying flags and scales counts and minutes. Used by compileTestSpec and by createMockFromBlueprint.
 */
export function compilePatternSections(
  bp: ExamBlueprint,
  opts: { section_positions?: number[] | undefined; scale_percent?: number | undefined; question_count?: number | undefined } = {},
): { sections: AssessmentSection[]; total: number; wholeMinutes: number | null; isShort: boolean } {
  // Z-42: sections are all timed one by one, or the whole test has ONE timer and the candidate moves freely.
  const sectional = bp.sections.every((s) => s.sectional_timing);
  const picked = opts.section_positions === undefined ? null : new Set(opts.section_positions);
  if (picked !== null && (picked.size === 0 || [...picked].some((i) => !Number.isInteger(i) || i < 0 || i >= bp.sections.length))) {
    throw bad("section_positions must list valid blueprint sections", "section_positions");
  }
  const pct = opts.scale_percent ?? 100;
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw bad("scale_percent must be a whole number from 1 to 100", "scale_percent");
  const chosen = bp.sections.filter((_, i) => picked === null || picked.has(i));
  const poolTotal = chosen.reduce((n, s) => n + s.question_count, 0);
  // EXP-35: a fixed count (practice mock, cap 100) is shared over the chosen sections by size, largest remainder first.
  const fixed = opts.question_count;
  let counts: number[];
  if (fixed !== undefined) {
    if (opts.scale_percent !== undefined) throw bad("Give a question count or a percent, not both", "question_count");
    if (!Number.isInteger(fixed) || fixed < 1 || fixed > MAX_QUESTIONS_PER_ASSESSMENT) throw bad(`question_count must be 1 to ${MAX_QUESTIONS_PER_ASSESSMENT}`, "question_count");
    if (fixed > poolTotal) throw bad(`question_count is above the ${poolTotal} questions of the chosen sections`, "question_count");
    const exact = chosen.map((s) => (s.question_count * fixed) / poolTotal);
    counts = exact.map(Math.floor);
    let left = fixed - counts.reduce((n, c) => n + c, 0);
    [...exact.keys()].sort((a, b) => (exact[b]! - counts[b]!) - (exact[a]! - counts[a]!) || a - b).forEach((i) => { if (left > 0) { counts[i]!++; left--; } });
  } else {
    counts = chosen.map((s) => Math.max(1, Math.round((s.question_count * pct) / 100)));
  }
  const isShort = picked !== null || pct < 100 || fixed !== undefined;
  const sections: AssessmentSection[] = chosen.map((s, i) => ({ s, n: counts[i]! })).filter(({ n }) => n > 0).map(({ s, n }) => ({
    name: s.name,
    question_count: isShort ? n : s.question_count,
    ...(s.subject_node_id !== null ? { node_id: s.subject_node_id } : {}), // Z-123: the draw filters by this node
    ...(sectional ? { minutes: isShort ? Math.max(1, Math.round((s.minutes as number) * n / s.question_count)) : (s.minutes as number) } : {}),
    marks_per_question: s.marks_per_question,
    negative_marks_per_question: s.negative_marks_per_question,
    ...(s.calculator_allowed ? { calculator: true } : {}),
    allowed_types: s.allowed_types as AssessmentSection["allowed_types"], // EXP-34: the draw enforces it
    ...(!isShort && s.qualifying ? { qualifying: true } : {}),
    ...(!isShort && s.qualifying && s.cutoff_marks !== null ? { cutoff_marks: s.cutoff_marks } : {}),
  }));
  const total = sections.reduce((n, s) => n + (s.question_count ?? 0), 0);
  const wholeMinutes = sectional
    ? null
    : isShort ? Math.min(600, Math.max(1, Math.ceil((bp.total_minutes * total) / bp.total_questions))) : bp.total_minutes;
  return { sections, total, wholeMinutes, isShort };
}

export function compileTestSpec(input: CompileTestInput): CompiledTest {
  const { cover } = input;
  const warnings: string[] = [];
  const label = input.today ? ` ${input.today}` : "";
  if (cover.kind === "whole") {
    if (!Number.isInteger(cover.question_count) || cover.question_count < 1 || cover.question_count > MAX_QUESTIONS_PER_ASSESSMENT) {
      throw bad(`question_count must be 1 to ${MAX_QUESTIONS_PER_ASSESSMENT}`, "cover.question_count");
    }
    return {
      name: input.name?.trim() || `Test${label}`,
      question_count: cover.question_count,
      ...(input.minutes !== undefined ? { duration_minutes: input.minutes } : {}),
      settings: {},
      warnings,
    };
  }
  if (cover.kind === "topics") {
    const sections = buildTopicSections(cover.topics, input.topicNames, input.difficulty_min, input.difficulty_max);
    const total = cover.topics.reduce((n, t) => n + t.count, 0);
    return {
      name: input.name?.trim() || `Topic test${label}`,
      question_count: total,
      settings: { sections, whole_test_minutes: Math.min(600, Math.max(1, input.minutes ?? Math.ceil(total * 1.5))), drill: true },
      warnings,
    };
  }
  const bp = input.blueprint;
  if (bp === undefined) throw bad("the exam pattern was not found", "cover.blueprint_id");
  if (bp.archived_at !== null) throw bad("This exam pattern is archived. Pick a current pattern.", "cover.blueprint_id");
  if (bp.verification_status !== "verified") warnings.push("This blueprint is not verified.");
  const p = compilePatternSections(bp, { section_positions: cover.section_positions, scale_percent: cover.scale_percent, question_count: cover.question_count });
  return {
    name: input.name?.trim() || `${bp.name} ${p.isShort ? "practice mock" : "full mock"}`,
    question_count: p.total,
    settings: {
      sections: p.sections,
      ...(p.wholeMinutes !== null ? { whole_test_minutes: p.wholeMinutes } : {}),
      exam_blueprint: { id: bp.id, edition: bp.edition, verification_status: bp.verification_status },
    },
    warnings,
  };
}
