/**
 * Least-AI grading tiers 1-2 (SP5). Both produce PROPOSALS only — D8 unchanged:
 * gradings rows are still written only by handleAdminAccept / override. No AI call here.
 *
 * Tier 1 (rule): blank / near-blank answer -> band 0 "No answer given". No keyword
 *   matching, no off-topic detection (needs AI), never awards marks.
 * Tier 2 (reuse): an identical normalised answer to the same (question_id,
 *   question_version) already has a FINAL accepted AI-path grade in the SAME tenant
 *   (RLS) graded under the current grade-anchors/grade-band prompts -> same band.
 */
import type { PoolClient } from "pg";
import { skillSha } from "./skill-sha.js";
import type { GradingProposal } from "./types.js";

const MIN_CHARS = 3;

/** All string leaves of an answer payload, in order (works for every answer shape). */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v !== null && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  return out;
}

export function isBlankAnswer(answer: unknown): boolean {
  return leaves(answer).join("").replace(/\s+/g, "").length < MIN_CHARS;
}

/** trim + collapse whitespace, case KEPT, structure kept (keys sorted). */
export function normaliseAnswer(v: unknown): string {
  const norm = (x: unknown): unknown =>
    typeof x === "string"
      ? x.trim().replace(/\s+/g, " ") // case kept: KQL/code identifiers are case-sensitive (codex 2026-10-02)
      : Array.isArray(x)
        ? x.map(norm)
        : x !== null && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([k, val]) => [k, norm(val)]),
            )
          : x;
  return JSON.stringify(norm(v));
}

export function ruleProposal(attemptId: string, questionId: string, points: number): GradingProposal {
  return {
    attempt_id: attemptId,
    question_id: questionId,
    anchors: [],
    band: { reasoning_band: 0, ai_justification: "No answer given", error_class: null, needs_escalation: false },
    score_earned: 0,
    score_max: points,
    prompt_version_sha: "rule:blank-v1",
    prompt_version_label: "rule",
    model: "rule",
    escalation_chosen_stage: null,
    generated_at: new Date().toISOString(),
    source: "rule",
  };
}

interface Candidate {
  id: string;
  answer: unknown;
  score_earned: string;
  score_max: string;
  reasoning_band: number | null;
  anchor_hits: GradingProposal["anchors"] | null;
  prompt_version_sha: string;
  prompt_version_label: string;
}

/** Current grade-anchors / grade-band short shas, or null if the skills can't be read (fail closed). */
async function currentShas(): Promise<{ anchors: string; band: string } | null> {
  try {
    return { anchors: (await skillSha("grade-anchors")).short, band: (await skillSha("grade-band")).short };
  } catch {
    return null;
  }
}

/**
 * Reuse proposal for one question, or null. Runs on a withTenant client, so only this
 * tenant's gradings are visible. A source grading must be: grader 'ai' (never an admin
 * override row), non-flagged, the NEWEST grading of its question (so an AI grade that
 * was later overridden / re-evaluated is excluded), on an attempt already graded or
 * released, same question_version, same points, and pinned to the current band prompt
 * (anchors prompt too when stage 1 ran). Matching sources that disagree on the score
 * -> ambiguous -> null (AI decides).
 */
export async function reuseProposal(
  client: PoolClient,
  p: { attemptId: string; questionId: string; questionVersion: number; points: number; answer: unknown },
): Promise<GradingProposal | null> {
  const { rows } = await client.query<Candidate>(
    `SELECT g.id, aa.answer, g.score_earned, g.score_max, g.reasoning_band, g.anchor_hits,
            g.prompt_version_sha, g.prompt_version_label
       FROM gradings g
       JOIN attempts a ON a.id = g.attempt_id
       JOIN attempt_questions aq ON aq.attempt_id = g.attempt_id AND aq.question_id = g.question_id
       JOIN attempt_answers aa ON aa.attempt_id = g.attempt_id AND aa.question_id = g.question_id
      WHERE g.question_id = $1
        AND aq.question_version = $2
        AND g.attempt_id <> $3
        AND g.grader = 'ai'
        AND g.override_of IS NULL
        AND g.status IN ('correct','incorrect','partial')
        AND g.score_max = $4
        AND a.status IN ('graded','released')
        AND NOT EXISTS (SELECT 1 FROM gradings n
                         WHERE n.attempt_id = g.attempt_id AND n.question_id = g.question_id
                           AND n.id <> g.id AND n.graded_at >= g.graded_at)
      ORDER BY g.graded_at DESC
      LIMIT 500`,
    [p.questionId, p.questionVersion, p.attemptId, p.points],
  );
  const key = normaliseAnswer(p.answer);
  const same = rows.filter((r) => r.reasoning_band !== null && normaliseAnswer(r.answer) === key);
  if (same.length === 0) return null;
  const shas = await currentShas();
  if (shas === null) return null;
  const ok = same.filter((r) => {
    const seg = (name: string) => new RegExp(`(?:^|[:;])${name}:([^;]+)`).exec(r.prompt_version_sha)?.[1];
    const a = seg("anchors");
    return seg("band") === shas.band && (a === "-" || a === shas.anchors);
  });
  const src = ok[0];
  // Ambiguous unless every match agrees on BOTH score and band (codex 2026-10-02).
  // Rubric is bound by construction: grading reads qv.rubric of the frozen
  // question_version (admin-grade.ts frozen-question SELECT), and reuse requires the
  // same question_version, so the same rubric snapshot.
  if (
    src === undefined ||
    ok.some(
      (r) => Number(r.score_earned) !== Number(src.score_earned) || r.reasoning_band !== src.reasoning_band,
    )
  )
    return null;
  return {
    attempt_id: p.attemptId,
    question_id: p.questionId,
    anchors: src.anchor_hits ?? [],
    band: {
      reasoning_band: src.reasoning_band as number,
      ai_justification: "Same answer as an earlier accepted grade",
      error_class: null,
      needs_escalation: false,
    },
    score_earned: Number(src.score_earned),
    score_max: p.points,
    prompt_version_sha: `reuse:${src.prompt_version_sha}`,
    prompt_version_label: src.prompt_version_label,
    model: "reuse",
    escalation_chosen_stage: null,
    generated_at: new Date().toISOString(),
    source: "reuse",
    reused_from_grading_id: src.id,
  };
}
