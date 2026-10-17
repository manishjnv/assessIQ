// AssessIQ — modules/15-analytics/src/question-stats.ts
//
// RW-60 / FU-C14 — Phase C per-question report (super admin, read-only SQL, no AI).
// Spec: docs/design/2026-05-23-question-difficulty-spec.md § 6.
//
// Flow: system read-only lookup of the tenant of the question (questions -> question_packs),
// then everything else under withTenant(thatTenant). question_stats_mv is not under
// RLS, so each read filters tenant_id explicitly (tools/lint-mv-tenant-filter.ts).
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { AppError } from '@assessiq/core';
import { withSystemRole, withTenant } from '@assessiq/tenancy';

export const MIN_PHASE_C_ATTEMPTS = 30;
const DISCRIMINATION_MIN = 0.2; // spec § 6: item-rest point-biserial >= 0.2 else noise
const MARGIN = 0.15; // spec § 6: margin between adjacent levels

export interface GradientRow {
  level_position: number;
  label: string;
  mean_success: number | null;
  attempts: number;
}

export interface QuestionStatsResult {
  question: {
    id: string;
    type: string;
    level_position: number;
    level_label: string;
    cognitive_level: string | null;
    difficulty_params: unknown;
  };
  stats: null | {
    attempts: number;
    exposure_count: number;
    correct_rate: number | null;
    mean_band: number | null;
    point_biserial: number | null;
    discrimination_ok: boolean | null;
    last_used_at: string | null;
    computed_at: string;
  };
  gradient: GradientRow[];
  miscalibrated: { flag: boolean; reason: string | null; min_attempts: number };
  /** tenant: this question under its own tenant. rollup: source question plus all clones, all tenants. */
  scope: 'tenant' | 'rollup';
  clone_count: number;
}

/**
 * ponytail: the spec gives no numeric threshold for "miscalibrated", so this is a
 * default: needs 30+ attempts; flagged when the item is >= 90% success on the
 * top level of the pack, <= 25% on the bottom level, or when the pack gradient at the
 * level of the item inverts against an adjacent level by more than 0.15.
 * Upgrade path: make the thresholds per-pack settings once real data exists.
 */
export function computeMiscalibrated(
  success: number | null,
  attempts: number,
  levelPosition: number,
  gradient: GradientRow[],
): { flag: boolean; reason: string | null; min_attempts: number } {
  const no = { flag: false, reason: null, min_attempts: MIN_PHASE_C_ATTEMPTS };
  if (success === null || attempts < MIN_PHASE_C_ATTEMPTS) return no;
  const idx = gradient.findIndex((g) => g.level_position === levelPosition);
  if (idx < 0) return no;
  const pct = Math.round(success * 100);
  const hit = (reason: string) => ({ flag: true, reason, min_attempts: MIN_PHASE_C_ATTEMPTS });
  if (gradient.length > 1) {
    if (idx === gradient.length - 1 && success >= 0.9) {
      return hit(`Top level item, but ${pct}% of candidates succeed. It looks too easy for its level.`);
    }
    if (idx === 0 && success <= 0.25) {
      return hit(`Lowest level item, but only ${pct}% of candidates succeed. It looks too hard for its level.`);
    }
  }
  const here = gradient[idx]!.mean_success;
  const lower = idx > 0 ? gradient[idx - 1]!.mean_success : null;
  const upper = idx < gradient.length - 1 ? gradient[idx + 1]!.mean_success : null;
  if (here !== null && lower !== null && here > lower + MARGIN) {
    return hit('This level scores higher than the level below it. The level order is inverted.');
  }
  if (here !== null && upper !== null && here + MARGIN < upper) {
    return hit('This level scores lower than the level above it. The level order is inverted.');
  }
  return no;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface QRow {
  id: string; type: string; pack_id: string; cognitive_level: string | null;
  difficulty_params: unknown; position: number; label: string;
}
interface SRow {
  attempts: string | number; exposure_count: string | number; correct_rate: string | null; mean_band: string | null;
  point_biserial: string | null; last_used_at: Date | null; computed_at: Date;
}
interface GRow { position: number; label: string; attempts: string; mean_success: string | null }

function assemble(
  qr: QRow, row: SRow | undefined, grows: GRow[], scope: 'tenant' | 'rollup', cloneCount: number,
): QuestionStatsResult {
  const gradient: GradientRow[] = grows.map((r) => ({
    level_position: r.position,
    label: r.label,
    mean_success: num(r.mean_success),
    attempts: Number(r.attempts),
  }));
  const pb = row ? num(row.point_biserial) : null;
  const stats = row
    ? {
        attempts: Number(row.attempts),
        exposure_count: Number(row.exposure_count),
        correct_rate: num(row.correct_rate),
        mean_band: num(row.mean_band),
        point_biserial: pb,
        discrimination_ok: pb === null ? null : pb >= DISCRIMINATION_MIN,
        last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
        computed_at: row.computed_at.toISOString(),
      }
    : null;
  const success = stats ? (stats.mean_band ?? stats.correct_rate) : null;
  return {
    question: {
      id: qr.id, type: qr.type, level_position: qr.position, level_label: qr.label,
      cognitive_level: qr.cognitive_level, difficulty_params: qr.difficulty_params,
    },
    stats,
    gradient,
    miscalibrated: computeMiscalibrated(success, stats?.attempts ?? 0, qr.position, gradient),
    scope,
    clone_count: cloneCount,
  };
}

const QUESTION_SQL = `SELECT q.id, q.type, q.pack_id, q.cognitive_level, q.difficulty_params, l.position, l.label
         FROM questions q JOIN levels l ON l.id = q.level_id WHERE q.id = $1`;

export async function getQuestionStats(questionId: string): Promise<QuestionStatsResult> {
  const found = await withSystemRole('super-admin question stats tenant lookup (read-only)', async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    const r = await client.query<{ tenant_id: string; clones: string }>(
      `SELECT p.tenant_id,
              (SELECT count(*) FROM questions c WHERE c.source_question_id = q.id)::text AS clones
         FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE q.id = $1`,
      [questionId],
    );
    return r.rows[0];
  });
  if (found === undefined) {
    throw new AppError('question not found', 'QUESTION_NOT_FOUND', 404);
  }
  const cloneCount = Number(found.clones);
  if (cloneCount > 0) return getRollup(questionId, cloneCount);

  return withTenant(found.tenant_id, async (client) => {
    const q = await client.query<QRow>(QUESTION_SQL, [questionId]);
    const qr = q.rows[0];
    if (qr === undefined) {
      throw new AppError('question not found', 'QUESTION_NOT_FOUND', 404);
    }
    const s = await client.query<SRow>(
      `SELECT attempts, exposure_count, correct_rate, mean_band, point_biserial, last_used_at, computed_at
         FROM question_stats_mv
        WHERE tenant_id = current_setting('app.current_tenant', true)::uuid AND question_id = $1`,
      [questionId],
    );
    const g = await client.query<GRow>(
      `SELECT l.position, l.label,
              COALESCE(SUM(s.attempts), 0)::text AS attempts,
              SUM(COALESCE(s.mean_band, s.correct_rate) * s.attempts)
                / NULLIF(SUM(s.attempts) FILTER (WHERE COALESCE(s.mean_band, s.correct_rate) IS NOT NULL), 0) AS mean_success
         FROM levels l
         LEFT JOIN question_stats_mv s
           ON s.level_id = l.id AND s.attempts > 0
          AND s.tenant_id = current_setting('app.current_tenant', true)::uuid
        WHERE l.pack_id = $1
        GROUP BY l.position, l.label
        ORDER BY l.position`,
      [qr.pack_id],
    );
    return assemble(qr, s.rows[0], g.rows, 'tenant', 0);
  });
}

/**
 * Cross-tenant roll-up for a source (platform) question: tenants answer CLONES of it
 * (questions.source_question_id, migration 0084), so its own tenant sees nothing.
 * Read-only system role; the two MV queries carry the lint allow marker. Sums are exact.
 * point_biserial and mean_band are attempts-weighted means of the per-tenant values, an
 * approximation of the pooled item-rest correlation (the pooled value needs raw rows).
 */
async function getRollup(questionId: string, cloneCount: number): Promise<QuestionStatsResult> {
  return withSystemRole('super-admin question stats roll-up across clones (read-only)', async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    const q = await client.query<QRow>(QUESTION_SQL, [questionId]);
    const qr = q.rows[0];
    if (qr === undefined) throw new AppError('question not found', 'QUESTION_NOT_FOUND', 404);

    const s = await client.query<SRow>(
      `-- mv-tenant-filter: allow cross-tenant (super_admin roll-up, RW-60)
       SELECT COALESCE(SUM(attempts), 0)::text AS attempts,
              COALESCE(SUM(exposure_count), 0)::text AS exposure_count,
              SUM(correct_count)::numeric / NULLIF(SUM(attempts), 0) AS correct_rate,
              SUM(mean_band * attempts) / NULLIF(SUM(attempts) FILTER (WHERE mean_band IS NOT NULL), 0) AS mean_band,
              SUM(point_biserial * attempts) / NULLIF(SUM(attempts) FILTER (WHERE point_biserial IS NOT NULL), 0) AS point_biserial,
              MAX(last_used_at) AS last_used_at,
              MAX(computed_at) AS computed_at
         FROM question_stats_mv
        WHERE question_id = $1 OR source_question_id = $1`,
      [questionId],
    );
    const agg = s.rows[0];
    const row = agg && agg.computed_at !== null ? agg : undefined;

    const g = await client.query<GRow>(
      `-- mv-tenant-filter: allow cross-tenant (super_admin roll-up, RW-60)
       SELECT lp.position, lp.label,
              COALESCE(SUM(x.attempts), 0)::text AS attempts,
              SUM(COALESCE(x.mean_band, x.correct_rate) * x.attempts)
                / NULLIF(SUM(x.attempts) FILTER (WHERE COALESCE(x.mean_band, x.correct_rate) IS NOT NULL), 0) AS mean_success
         FROM levels lp
         LEFT JOIN (
           SELECT s.attempts, s.mean_band, s.correct_rate, l.position
             FROM question_stats_mv s
             JOIN levels l ON l.id = s.level_id
             JOIN question_packs p ON p.id = s.pack_id
            WHERE s.attempts > 0 AND (p.id = $1 OR p.source_pack_id = $1)
         ) x ON x.position = lp.position
        WHERE lp.pack_id = $1
        GROUP BY lp.position, lp.label
        ORDER BY lp.position`,
      [qr.pack_id],
    );
    return assemble(qr, row, g.rows, 'rollup', cloneCount);
  });
}
