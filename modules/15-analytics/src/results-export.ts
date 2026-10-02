// AssessIQ — modules/15-analytics/src/results-export.ts
//
// LIVE per-assessment results CSV (placement-cell export). Reads live tables
// (no attempt_summary_mv): one row per INVITED candidate, latest attempt,
// latest effective grading per question (graded_at DESC — same rule as
// 09-scoring getGradingsForAttempt; an admin_override row is newer than the
// row it overrides, and wins graded_at ties), per-category %, pass/fail
// against levels.passing_score_pct.
//
// Phase II (2026-10-01): an attempt whose evaluation the platform has not released
// to the tenant yet (still unevaluated, or graded but evaluation_released_at IS NULL —
// e.g. sent back) shows result "Awaiting evaluation" and NO score / percent / category
// columns. Published ('released') and released-to-tenant rows show their score.
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

export const RESULTS_SORTS = ['name', 'rank', 'branch'] as const;
export type ResultsSort = (typeof RESULTS_SORTS)[number];

export interface ResultsCsv {
  csv: string;
  filenameBase: string; // assessment id (assessments has no slug column)
}

export async function buildAssessmentResultsCsv(
  tenantId: string,
  assessmentId: string,
  sort: ResultsSort = 'name',
): Promise<ResultsCsv> {
  return withTenant(tenantId, async (client) => {
    // RLS on assessments hides other tenants' rows → 404.
    const a = await client.query<{ passing: number | null; sections: unknown }>(
      `SELECT l.passing_score_pct AS passing, a.settings->'sections' AS sections
         FROM assessments a LEFT JOIN levels l ON l.id = a.level_id
        WHERE a.id = $1`,
      [assessmentId],
    );
    if (a.rows.length === 0) throw new NotFoundError('assessment not found');
    const passing = a.rows[0]!.passing;
    // Test sections: one extra column per section (names from settings; [] = none).
    const rawSections = a.rows[0]!.sections;
    const sectionNames: string[] = Array.isArray(rawSections)
      ? rawSections.map((x, i) => String((x as { name?: unknown })?.name ?? `Section ${i + 1}`))
      : [];

    const cands = await client.query<{
      user_id: string; name: string | null; email: string; inv_status: string;
      attempt_id: string | null; status: string | null;
      started_at: Date | null; submitted_at: Date | null;
      evaluation_released_at: Date | null;
      roll_number: string | null; branch: string | null;
    }>(
      `SELECT i.user_id, u.name, u.email, i.status AS inv_status,
              u.metadata->>'roll_number' AS roll_number, u.metadata->>'branch' AS branch,
              at.id AS attempt_id, at.status, at.started_at, at.submitted_at,
              at.evaluation_released_at
         FROM assessment_invitations i
         JOIN users u ON u.id = i.user_id
         LEFT JOIN LATERAL (
           SELECT id, status, started_at, submitted_at, evaluation_released_at FROM attempts
            WHERE assessment_id = i.assessment_id AND user_id = i.user_id
            ORDER BY created_at DESC LIMIT 1) at ON true
        WHERE i.assessment_id = $1
        ORDER BY lower(u.name), u.email
        LIMIT ${RESULTS_ROW_CAP}`,
      [assessmentId],
    );

    // Integrity signals (not scores — shown regardless of release state).
    // 'fullscreen_exit' is emitted by the attempt engine; 0 until it exists.
    const ev = await client.query<{ attempt_id: string; tabs: string; pastes: string; fs: string }>(
      `SELECT e.attempt_id,
              count(*) FILTER (WHERE e.event_type = 'tab_blur')        AS tabs,
              count(*) FILTER (WHERE e.event_type = 'paste')           AS pastes,
              count(*) FILTER (WHERE e.event_type = 'fullscreen_exit') AS fs
         FROM attempt_events e
         JOIN attempts at ON at.id = e.attempt_id AND at.assessment_id = $1
        GROUP BY e.attempt_id`,
      [assessmentId],
    );
    const integrity = new Map(ev.rows.map((r) => [r.attempt_id, r]));

    // Effective grading per (attempt, question) with category, for this assessment.
    const gr = await client.query<{
      attempt_id: string; earned: string; max: string; category: string | null;
      section_index: number | null;
    }>(
      `SELECT DISTINCT ON (g.attempt_id, g.question_id)
              g.attempt_id, g.score_earned::text AS earned, g.score_max::text AS max,
              c.name AS category, aq.section_index
         FROM gradings g
         JOIN attempts at ON at.id = g.attempt_id AND at.assessment_id = $1
         LEFT JOIN attempt_questions aq ON aq.attempt_id = g.attempt_id AND aq.question_id = g.question_id
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

    const byAttempt = new Map<string, { e: number; m: number; cat: Map<string, [number, number]>; sec: Map<number, [number, number]> }>();
    for (const r of gr.rows) {
      const t = byAttempt.get(r.attempt_id) ?? { e: 0, m: 0, cat: new Map(), sec: new Map() };
      const e = parseFloat(r.earned);
      const m = parseFloat(r.max);
      t.e += e;
      t.m += m;
      if (r.section_index !== null) {
        const x = t.sec.get(r.section_index) ?? [0, 0];
        t.sec.set(r.section_index, [x[0] + e, x[1] + m]);
      }
      if (r.category) {
        const c = t.cat.get(r.category) ?? [0, 0];
        t.cat.set(r.category, [c[0] + e, c[1] + m]);
      }
      byAttempt.set(r.attempt_id, t);
    }

    const header = [
      'name', 'email', 'roll_number', 'branch', 'status', 'started_at', 'submitted_at',
      'score', 'max_score', 'percent', 'result', 'rank',
      'tab_switches', 'paste_count', 'fullscreen_exits',
      ...categories.map((c) => `${c} (%)`),
      ...sectionNames.map((n) => `Section: ${n} (%)`),
    ];
    const rows = cands.rows.map((c) => {
      const status = c.status ?? (c.inv_status === 'expired' ? 'expired' : 'invited');
      // Phase II: while the platform has not released its evaluation to the tenant
      // (still queued with AssessIQ, or sent back), the row shows "Awaiting
      // evaluation" and NO score — the tenant sees scores only after release-to-tenant.
      // 'released' (published) rows always show their score.
      const awaiting =
        c.attempt_id !== null &&
        (c.status === 'submitted' ||
          c.status === 'auto_submitted' ||
          c.status === 'pending_admin_grading' ||
          (c.status === 'graded' && c.evaluation_released_at === null));
      const graded =
        c.attempt_id !== null &&
        (c.status === 'released' || (c.status === 'graded' && c.evaluation_released_at !== null));
      const t = graded ? byAttempt.get(c.attempt_id!) : undefined;
      const percent = t && t.m > 0 ? Math.round((t.e / t.m) * 1000) / 10 : null;
      const result = awaiting
        ? 'Awaiting evaluation'
        : percent !== null && passing !== null ? (percent >= passing ? 'Pass' : 'Fail') : '';
      const ie = c.attempt_id !== null ? integrity.get(c.attempt_id) : undefined;
      return { c, status, t, percent, result, rank: null as number | null, ie };
    });

    // Competition ranking (1,2,2,4) by percent DESC over rows with a visible score.
    const ranked = rows.filter((r) => r.percent !== null).sort((x, y) => y.percent! - x.percent!);
    ranked.forEach((r, i) => {
      r.rank = i > 0 && ranked[i - 1]!.percent === r.percent ? ranked[i - 1]!.rank : i + 1;
    });

    // Array.sort is stable, so ties keep the SQL name order.
    // ponytail: blanks sort last; localeCompare for branch A->Z.
    if (sort === 'rank') {
      rows.sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity));
    } else if (sort === 'branch') {
      rows.sort((x, y) => {
        const bx = x.c.branch ?? '', by = y.c.branch ?? '';
        if (bx === '' || by === '') return bx === by ? (x.rank ?? Infinity) - (y.rank ?? Infinity) : bx === '' ? 1 : -1;
        return bx.localeCompare(by) || (x.rank ?? Infinity) - (y.rank ?? Infinity);
      });
    }

    const lines = [header.map(csvCell).join(',')];
    for (const { c, status, t, percent, result, rank, ie } of rows) {
      const cells: Array<string | number | null> = [
        c.name ?? '', c.email, c.roll_number ?? '', c.branch ?? '', status,
        c.started_at?.toISOString() ?? '', c.submitted_at?.toISOString() ?? '',
        t ? t.e : '', t ? t.m : '', percent ?? '', result, rank ?? '',
        ie ? Number(ie.tabs) : c.attempt_id ? 0 : '',
        ie ? Number(ie.pastes) : c.attempt_id ? 0 : '',
        ie ? Number(ie.fs) : c.attempt_id ? 0 : '',
        ...categories.map((n) => {
          const x = t?.cat.get(n);
          return x ? pct(x[0], x[1]) : '';
        }),
        // `t` is only set for visible (released) scores, so section columns blank otherwise.
        ...sectionNames.map((_, i) => {
          const x = t?.sec.get(i);
          return x ? pct(x[0], x[1]) : '';
        }),
      ];
      lines.push(cells.map(csvCell).join(','));
    }
    return { csv: BOM + lines.join('\r\n') + '\r\n', filenameBase: assessmentId };
  });
}
