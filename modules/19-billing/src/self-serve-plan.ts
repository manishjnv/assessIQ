// AssessIQ — modules/19-billing/src/self-serve-plan.ts
//
// Z-71: the billing part of a self-serve sign-up. Runs on the CALLER's system-role client
// inside createSelfServeTenant's transaction (02-tenancy), so the Free plan, the monthly
// credit grant and the sample-set entitlements commit or roll back with the new tenant.
// No second provisioning path: the plan and grant come from provisionDefaultPlanInTx.

import type { PoolClient } from 'pg';
import { provisionDefaultPlanInTx } from './service.js';
import { getPlatformTenantId, insertEntitlement } from './repository.js';

/**
 * The fixed sample sets of the Free plan, in grant order (owner 2026-10-19: 5 fixed sample
 * sets, aptitude first). Slugs of PLATFORM-library packs. A slug with no published platform
 * pack is skipped, so fewer than 5 are granted until the missing packs are published. Only
 * `campus-placement-aptitude` is seeded in the repository today (its content migration is
 * kept outside git); append the other four slugs here when those packs are published.
 */
export const FREE_SAMPLE_PACK_SLUGS: readonly string[] = ['campus-placement-aptitude'];

const MAX_SAMPLE_PACKS = 5;

export async function provisionSelfServePlan(
  client: PoolClient,
  tenantId: string,
): Promise<{ plan: 'free'; packsGranted: number }> {
  await provisionDefaultPlanInTx(client, tenantId);

  const platformId = await getPlatformTenantId(client);
  let packsGranted = 0;
  if (platformId !== null && platformId !== tenantId) {
    // Latest published version of each slug.
    const packs = await client.query<{ id: string; slug: string }>(
      `SELECT DISTINCT ON (p.slug) p.id, p.slug
         FROM question_packs p
        WHERE p.tenant_id = $1 AND p.status = 'published' AND p.slug = ANY($2::text[])
        ORDER BY p.slug, p.version DESC`,
      [platformId, [...FREE_SAMPLE_PACK_SLUGS]],
    );
    const rank = (slug: string): number => FREE_SAMPLE_PACK_SLUGS.indexOf(slug);
    const chosen = packs.rows.sort((a, b) => rank(a.slug) - rank(b.slug)).slice(0, MAX_SAMPLE_PACKS);
    for (const row of chosen) {
      await insertEntitlement(client, tenantId, 'pack', row.id, null);
      packsGranted += 1;
    }
  }
  return { plan: 'free', packsGranted };
}
