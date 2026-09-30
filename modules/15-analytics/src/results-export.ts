// AssessIQ — modules/15-analytics/src/results-export.ts
//
// LIVE per-assessment results CSV (placement-cell export). Reads live tables
// (no attempt_summary_mv): one row per INVITED candidate, latest attempt,
// latest effective grading per question (graded_at DESC — same rule as
// 09-scoring getGradingsForAttempt; an admin_override row is newer than the
// row it overrides, and wins graded_at ties), per-category %, pass/fail
// against levels.passing_score_pct.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { withTenant } from '@assessiq/tenancy';
import { NotFoundError } from '@assessiq/core';

export const RESULTS_ROW_CAP = 10_000;
const BOM = '﻿';

/** CSV cell: formula-injection guard (= + - @ tab CR) then RFC-4180 quoting. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pct = (e: number, m: number): string => (m > 0 ? String(Math.round((e / m) * 1000) / 10) : '');

export interface ResultsCsv {
  csv: string;
  filenameBase: string; // assessment id (assessments has no slug column)
}

export async function buildAssessmentResultsCsv(
  tenantId: string,
  assessmentId: string,
): Promise<ResultsCsv> {
  return withTenant(tenantId, async (client) => {
    // RLS on assessments hides other tenants' rows → 404.
    const a = await client.query<{ passing: number | null }>(
      `SELECT l.passing_score_pct AS passing
         FROM assessments a LEFT JOIN levels l ON l.id = a.level_id
        WHERE a.id = $1`,
      [assessmentId],
    );
    if (a.rows.length === 0) throw new NotFoundError('assessment not found');
    const passing = a.rows[0]!.passing;

    const cands = await client.query<{
      user_id: string; name: string | null; email: string; inv_status: string;
      attempt_id: string | null; status: string | null;
      started_at: Date | null; submitted_at: Date | null;
    }>(
      `SELECT i.user_id, u.name, u.email, i.status AS inv_status,
              at.id AS attempt_id, at.status, at.started_at, at.submitted_at
         FROM assessment_invitations i
         JOIN users u ON u.id = i.user_id
         LEFT JOIN LATERAL (
           SELECT id, status, started_at, submitted_at FROM attempts
            WHERE assessment_id = i.assessment_id AND user_id = i.user_id
            ORDER BY created_at DESC LIMIT 1) at ON true
        WHERE i.assessment_id = $1
        ORDER BY lower(u.name), u.email
        LIMIT ${RESULTS_ROW_CAP}`,
      [assessmentId],
    );

    // Effective grading per (attempt, question) with category, for this assessment.
    const gr = await client.query<{
      attempt_id: string; earned: string; max: string; category: string | null;
    }>(
      `SELECT DISTINCT ON (g.attempt_id, g.question_id)
              g.attempt_id, g.score_earned::text AS earned, g.score_max::text AS max,
              c.name AS category
         FROM gradings g
         JOIN attempts at ON at.id = g.attempt_id AND at.assessment_id = $1
         JOIN questions q ON q.id = g.question_id
         LEFT JOIN categories c ON c.id = q.category_id
        ORDER BY g.attempt_id, g.question_id,
                 g.graded_at DESC, (g.grader = 'admin_override') DESC`,
      [assessmentId],
    );
    // Categories present in the assessment's questions (served + graded).
    const cats = await client.query<{ name: string }>(
      `SELECT DISTINCT c.name
         FROM attempt_questions aq
         JOIN attempts at ON at.id = aq.attempt_id AND at.assessment_id = $1
         JOIN questions q ON q.id = aq.question_id
         JOIN categories c ON c.id = q.category_id`,
      [assessmentId],
    );
    const catNames = new Set(cats.rows.map((r) => r.name));
    for (const r of gr.rows) if (r.category) catNames.add(r.category);
    const categories = [...catNames].sort((x, y) => x.localeCompare(y));

    const byAttempt = new Map<string, { e: number; m: number; cat: Map<string, [number, number]> }>();
    for (const r of gr.rows) {
      const t = byAttempt.get(r.attempt_id) ?? { e: 0, m: 0, cat: new Map() };
      const e = parseFloat(r.earned);
      const m = parseFloat(r.max);
      t.e += e;
      t.m += m;
      if (r.category) {
        const c = t.cat.get(r.category) ?? [0, 0];
        t.cat.set(r.category, [c[0] + e, c[1] + m]);
      }
      byAttempt.set(r.attempt_id, t);
    }

    const header = [
      'name', 'email', 'status', 'started_at', 'submitted_at', 'score', 'max_score', 'percent', 'result',
      ...categories.map((c) => `${c} (%)`),
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const c of cands.rows) {
      const status = c.status ?? (c.inv_status === 'expired' ? 'expired' : 'invited');
      const graded = c.attempt_id !== null && (c.status === 'graded' || c.status === 'released');
      const t = graded ? byAttempt.get(c.attempt_id!) : undefined;
      const percent = t && t.m > 0 ? Math.round((t.e / t.m) * 1000) / 10 : null;
      const result = percent !== null && passing !== null ? (percent >= passing ? 'Pass' : 'Fail') : '';
      const cells: Array<string | number | null> = [
        c.name ?? '', c.email, status,
        c.started_at?.toISOString() ?? '', c.submitted_at?.toISOString() ?? '',
        t ? t.e : '', t ? t.m : '', percent ?? '', result,
        ...categories.map((n) => {
          const x = t?.cat.get(n);
          return x ? pct(x[0], x[1]) : '';
        }),
      ];
      lines.push(cells.map(csvCell).join(','));
    }
    return { csv: BOM + lines.join('\r\n') + '\r\n', filenameBase: assessmentId };
  });
}
