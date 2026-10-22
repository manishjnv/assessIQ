// EXP-22: withdraw every template_generated question whose seed_ref starts with a template prefix.
// Same effect as withdrawImport (withdrawInTx per question: rights_status 'withdrawn', status 'archived', audit row, clone takedown);
// frozen pools keep their copies (EXP-20). Uses the (tenant_id, seed_ref text_pattern_ops) index from migration 0246.
import { ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "../repository.js";
import { withdrawInTx } from "../service/questions.js";
import { assertRoleFitsTenant, asRetryableDeadlock } from "../service/review.js";
import { seedRefPrefixError } from "./v2.js";

export async function withdrawBySeedRefPrefix(
  tenantId: string,
  actorUserId: string,
  role: string | undefined,
  prefix: string,
  dryRun: boolean,
): Promise<{ seed_ref_prefix: string; matched: number; withdrawn: number; dry_run: boolean }> {
  const bad = seedRefPrefixError(prefix);
  if (bad !== null) throw new ValidationError(bad, { details: { code: "SEED_REF_PREFIX_INVALID" } });
  const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
  return withTenant(tenantId, async (client) => {
    await assertRoleFitsTenant(client, { tenantId, userId: actorUserId, role: role ?? "" });
    const ids = (await client.query<{ question_id: string }>(
      `SELECT question_id FROM question_source
        WHERE origin = 'template_generated' AND rights_status <> 'withdrawn' AND seed_ref LIKE $1 ESCAPE '\\'
        ORDER BY question_id`, [like],
    )).rows.map((r) => r.question_id);
    if (dryRun) return { seed_ref_prefix: prefix, matched: ids.length, withdrawn: 0, dry_run: true };
    let withdrawn = 0;
    for (const id of ids) {
      const q = await repo.findQuestionById(client, id);
      if (q === null) continue;
      await withdrawInTx(client, tenantId, actorUserId, q);
      withdrawn++;
    }
    return { seed_ref_prefix: prefix, matched: ids.length, withdrawn, dry_run: false };
  }).catch((err: unknown) => { throw asRetryableDeadlock(err); });
}
