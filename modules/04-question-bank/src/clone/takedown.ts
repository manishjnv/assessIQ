import { type PoolClient } from "pg";
import { auditInTx } from "@assessiq/audit-log";
import { getPlatformTenantId } from "./helpers.js";

/**
 * EXP-19: takedown propagation. When a PLATFORM question is withdrawn, mark every tenant clone
 * (questions.source_question_id = the withdrawn id) as withdrawn: status 'archived' plus
 * question_source.rights_status 'withdrawn', the same representation the platform row uses.
 *
 * MUST be called inside the withdraw transaction (withTenant client, assessiq_app role, platform
 * tenant GUC), after the master row is withdrawn. The tx is the atomicity boundary.
 *
 * Cross-tenant mechanism: the same role switch clone-on-grant.ts uses (SET LOCAL ROLE
 * assessiq_system for the cross-tenant read/write, SET LOCAL ROLE assessiq_app + set_config
 * app.current_tenant for each audit row). We do NOT call withSystemRole: it refuses to run
 * inside withTenant and opens its own connection (it could not share the withdraw tx).
 * Under the system role RLS is bypassed, so every statement carries an explicit tenant_id
 * predicate (through question_packs.tenant_id or question_source.tenant_id).
 *
 * Idempotent: only clones whose source row is not yet 'withdrawn' are selected, so a repeat call
 * finds none and writes no audit rows. A tenant with no clone yields no group and no audit row.
 * Frozen question_versions and the clone pack version are NOT touched (attempts keep their
 * pinned version; pools frozen on an assessment are EXP-20).
 *
 * Audit rows are written with actor_kind 'system' and no actor id: the actor is a platform user
 * and must not be written into a customer tenant's audit log.
 */
export async function propagateTakedown(
  client: PoolClient,
  masterQuestionId: string,
  callerTenantId: string,
): Promise<{ tenantsAffected: number; clonesMarked: number }> {
  await client.query("SET LOCAL ROLE assessiq_system");
  // After a query error the tx is aborted and restore queries would fail and mask the real error;
  // withTenant rolls the whole tx back on throw, so restore the caller context on success only.
  let failed = false;
  try {
    const platformTenantId = await getPlatformTenantId(client);
    // Only a platform-owned master has tenant clones; a tenant-owned question never does.
    const master = await client.query(
      `SELECT 1 FROM questions m JOIN question_packs mp ON mp.id = m.pack_id
        WHERE m.id = $1 AND mp.tenant_id = $2`,
      [masterQuestionId, platformTenantId],
    );
    if (master.rowCount === 0) return { tenantsAffected: 0, clonesMarked: 0 };

    // FOR UPDATE serialises two concurrent takedowns of the same master.
    const clones = await client.query<{ id: string; tenant_id: string }>(
      `SELECT cq.id, cp.tenant_id
         FROM questions cq
         JOIN question_packs cp ON cp.id = cq.pack_id
         LEFT JOIN question_source cs ON cs.question_id = cq.id
        WHERE cq.source_question_id = $1
          AND cp.tenant_id <> $2
          AND COALESCE(cs.rights_status, '') <> 'withdrawn'
        ORDER BY cp.tenant_id, cq.id
          FOR UPDATE OF cq`,
      [masterQuestionId, platformTenantId],
    );

    const byTenant = new Map<string, string[]>();
    for (const r of clones.rows) {
      const list = byTenant.get(r.tenant_id) ?? [];
      list.push(r.id);
      byTenant.set(r.tenant_id, list);
    }

    for (const [tenantId, ids] of byTenant) {
      await client.query(
        `UPDATE questions q SET status = 'archived', updated_at = now()
           FROM question_packs p
          WHERE q.id = ANY($1::uuid[]) AND p.id = q.pack_id AND p.tenant_id = $2`,
        [ids, tenantId],
      );
      const upserted = await client.query(
        `INSERT INTO question_source (tenant_id, question_id, origin, rights_status)
         SELECT $2::uuid, q.id, 'original_human', 'withdrawn'
           FROM questions q JOIN question_packs p ON p.id = q.pack_id
          WHERE q.id = ANY($1::uuid[]) AND p.tenant_id = $2
         ON CONFLICT (question_id) DO UPDATE SET rights_status = 'withdrawn'
           WHERE question_source.tenant_id = $2`,
        [ids, tenantId],
      );
      // A source row owned by another tenant is skipped by the guard above: fail loudly, never audit it.
      if (upserted.rowCount !== ids.length) {
        throw new Error(`takedown: source row tenant mismatch for tenant ${tenantId}`);
      }

      // Audit under the app role + this tenant's GUC (auditInTx's required context).
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await auditInTx(client, {
        tenantId,
        actorKind: "system",
        // The platform admin's network identity must not enter a customer tenant's audit log.
        ip: null,
        userAgent: null,
        action: "question.takedown_propagated",
        entityType: "question",
        entityId: masterQuestionId,
        after: {
          source_question_id: masterQuestionId,
          clone_question_ids: ids,
          status: "archived",
          rights_status: "withdrawn",
        },
      });
      await client.query("SET LOCAL ROLE assessiq_system");
    }

    return { tenantsAffected: byTenant.size, clonesMarked: clones.rows.length };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Restore the caller's context (withTenant: app role + the caller's tenant GUC).
    if (!failed) {
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [callerTenantId]);
    }
  }
}
