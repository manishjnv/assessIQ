// S109-D6: re-tag LIVE template rows from one subject-map node to another, by seed_ref prefix.
// Why: withdraw + reload of a live row does not work (the importer skips a known template seed_ref of any
// status, import/staging.ts + migration 0246), so rows are re-tagged in place. Only the link to fromNode is
// swapped; exam stage, exam style and every other framework link stay. Dry run is the default.
import { NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant, withSystemRoleDetached } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";
import { getPlatformTenantId } from "../clone/helpers.js";
import { seedRefPrefixError } from "../import/v2.js";
import { assertRoleFitsTenant, asRetryableDeadlock } from "./review.js";

export interface RetagMove { seedPrefix: string; fromNode: string; toNode: string }
export interface RetagInput { moves: RetagMove[]; dryRun?: boolean; packSlugs?: string[]; includeClones?: boolean }
export interface RetagMoveResult {
  seedPrefix: string; fromNode: string; toNode: string;
  matched: number; changed: number; skippedNotInFromNode: number; changedByPack: Record<string, number>;
  /** Only with includeClones: clone questions (organisation tenants) whose link was swapped (dry run: would be). */
  clonesChanged?: number;
}
export interface RetagResult {
  dryRun: boolean; moves: RetagMoveResult[];
  totals: { matched: number; changed: number; skippedNotInFromNode: number; clonesChanged: number };
}
export interface RetagCtx { tenantId: string; userId: string; role: string | undefined }

const FRAMEWORK = "subject-map";

/** Resolves "unit-path/outcome" style codes inside the platform subject-map. */
async function resolveNode(client: PoolClient, path: string): Promise<{ id: string; kind: string }> {
  const parts = path.split("/").filter((p) => p !== "");
  const bad = (m: string) => new ValidationError(m, { details: { code: "RETAG_NODE_INVALID", path } });
  if (parts.length === 0) throw bad(`empty node path`);
  let parentId: string | null = null;
  let found: { id: string; kind: string } | undefined;
  for (const code of parts) {
    found = (await client.query<{ id: string; kind: string }>(
      `SELECT n.id, n.kind FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
        WHERE f.tenant_id IS NULL AND f.slug = $1 AND n.tenant_id IS NULL AND n.code = $2
          AND n.parent_id IS NOT DISTINCT FROM $3::uuid`,
      [FRAMEWORK, code, parentId],
    )).rows[0];
    if (found === undefined) throw new NotFoundError(`subject-map node not found: ${path}`);
    parentId = found.id;
  }
  return found!;
}

const likeOf = (prefix: string): string => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

export async function retagBySeedPrefix(ctx: RetagCtx, input: RetagInput): Promise<RetagResult> {
  const dryRun = input.dryRun !== false;
  const slugs = input.packSlugs !== undefined && input.packSlugs.length > 0 ? input.packSlugs : null;
  for (const m of input.moves) {
    const bad = seedRefPrefixError(m.seedPrefix);
    if (bad !== null) throw new ValidationError(bad, { details: { code: "SEED_REF_PREFIX_INVALID" } });
  }
  const results: RetagMoveResult[] = [];
  const resolved: Array<{ from: string; to: string }> = [];
  let platformId = "";
  await withTenant(ctx.tenantId, async (client) => {
    const isPlatform = await assertRoleFitsTenant(client, { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role ?? "" });
    if (!isPlatform) throw new ValidationError("re-tag runs on the platform organisation only", { details: { code: "RETAG_PLATFORM_ONLY" } });
    platformId = ctx.tenantId;
    // Resolve every path first: one bad path fails the whole call before any write.
    for (const m of input.moves) {
      const from = await resolveNode(client, m.fromNode);
      const to = await resolveNode(client, m.toNode);
      if (to.kind !== "outcome") throw new ValidationError(`target node is not an outcome: ${m.toNode}`, { details: { code: "RETAG_TARGET_NOT_OUTCOME" } });
      resolved.push({ from: from.id, to: to.id });
    }
    for (const [i, m] of input.moves.entries()) {
      const { from, to } = resolved[i]!;
      const rows = (await client.query<{ id: string; slug: string; linked: boolean }>(
        `SELECT q.id, p.slug,
                EXISTS (SELECT 1 FROM question_taxonomy qt WHERE qt.question_id = q.id AND qt.node_id = $2) AS linked
           FROM question_source qs JOIN questions q ON q.id = qs.question_id JOIN question_packs p ON p.id = q.pack_id
          WHERE qs.origin = 'template_generated' AND qs.rights_status <> 'withdrawn'
            AND qs.seed_ref LIKE $1 ESCAPE '\\' AND ($3::text[] IS NULL OR p.slug = ANY($3::text[]))
          ORDER BY q.id`,
        [likeOf(m.seedPrefix), from, slugs],
      )).rows;
      const moving = rows.filter((r) => r.linked);
      const changedByPack: Record<string, number> = {};
      for (const r of moving) changedByPack[r.slug] = (changedByPack[r.slug] ?? 0) + 1;
      if (!dryRun && moving.length > 0) {
        await client.query(
          `WITH del AS (DELETE FROM question_taxonomy WHERE node_id = $1 AND question_id = ANY($3::uuid[]) RETURNING question_id)
           INSERT INTO question_taxonomy (question_id, node_id) SELECT question_id, $2 FROM del ON CONFLICT (question_id, node_id) DO NOTHING`,
          [from, to, moving.map((r) => r.id)],
        );
        await auditInTx(client, {
          tenantId: ctx.tenantId, actorKind: "user", actorUserId: ctx.userId,
          // ponytail: no dedicated AuditAction (module 14 is off limits); same reuse as the PUT taxonomy service.
          action: "question.updated", entityType: "question",
          before: { kind: "taxonomy_retag", seed_prefix: m.seedPrefix, node: m.fromNode },
          after: { kind: "taxonomy_retag", seed_prefix: m.seedPrefix, node: m.toNode, count: moving.length },
        });
      }
      results.push({
        seedPrefix: m.seedPrefix, fromNode: m.fromNode, toNode: m.toNode, matched: rows.length,
        changed: dryRun ? 0 : moving.length, skippedNotInFromNode: rows.length - moving.length, changedByPack,
      });
    }
  }).catch((err: unknown) => { throw asRetryableDeadlock(err); });

  if (input.includeClones === true) {
    // Clones are separate rows in organisation tenants: same cross-tenant mechanism as takedown and review propagation
    // (own system-role tx, per-tenant audit under assessiq_app). Selected by master prefix, not by master link, so it
    // stays correct after the master swap and a re-run finishes any clone left behind.
    await withSystemRoleDetached("question.retag_clones", async (client) => {
      const platform = platformId !== "" ? platformId : await getPlatformTenantId(client);
      for (const [i, m] of input.moves.entries()) {
        const { from, to } = resolved[i]!;
        const clones = (await client.query<{ id: string; tenant_id: string }>(
          `SELECT c.id, cp.tenant_id
             FROM questions c JOIN question_packs cp ON cp.id = c.pack_id
             JOIN questions mq ON mq.id = c.source_question_id JOIN question_packs mp ON mp.id = mq.pack_id
             JOIN question_source ms ON ms.question_id = mq.id
            WHERE mp.tenant_id = $1 AND cp.tenant_id <> $1 AND ms.origin = 'template_generated'
              AND ms.seed_ref LIKE $2 ESCAPE '\\' AND ($4::text[] IS NULL OR mp.slug = ANY($4::text[]))
              AND EXISTS (SELECT 1 FROM question_taxonomy qt WHERE qt.question_id = c.id AND qt.node_id = $3)
            ORDER BY cp.tenant_id, c.id`,
          [platform, likeOf(m.seedPrefix), from, slugs],
        )).rows;
        results[i]!.clonesChanged = clones.length;
        if (dryRun) continue;
        const byTenant = new Map<string, string[]>();
        for (const r of clones) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);
        for (const [tenantId, ids] of byTenant) {
          await client.query(
            `WITH del AS (DELETE FROM question_taxonomy WHERE node_id = $1 AND question_id = ANY($3::uuid[]) RETURNING question_id)
             INSERT INTO question_taxonomy (question_id, node_id) SELECT question_id, $2 FROM del ON CONFLICT (question_id, node_id) DO NOTHING`,
            [from, to, ids],
          );
          await client.query("SET LOCAL ROLE assessiq_app");
          await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
          await auditInTx(client, {
            tenantId, actorKind: "system", ip: null, userAgent: null,
            action: "question.updated", entityType: "question",
            before: { kind: "taxonomy_retag_clones", seed_prefix: m.seedPrefix, node: m.fromNode },
            after: { kind: "taxonomy_retag_clones", seed_prefix: m.seedPrefix, node: m.toNode, count: ids.length },
          });
          await client.query("RESET ROLE");
        }
      }
    });
  }

  const sum = (f: (r: RetagMoveResult) => number) => results.reduce((a, r) => a + f(r), 0);
  return {
    dryRun, moves: results,
    totals: { matched: sum((r) => r.matched), changed: sum((r) => r.changed), skippedNotInFromNode: sum((r) => r.skippedNotInFromNode), clonesChanged: sum((r) => r.clonesChanged ?? 0) },
  };
}
