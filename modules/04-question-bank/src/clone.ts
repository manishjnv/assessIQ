/**
 * modules/04-question-bank/src/clone.ts
 *
 * Clone-on-grant engine (Step 2 — question-set sharing).
 * See docs/design/question-set-sharing-clone-on-grant.md.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ READ THIS BEFORE EDITING — this file is the OPPOSITE of repository.ts.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * repository.ts / service.ts run under `assessiq_app` with `app.current_tenant`
 * set; RLS scopes every query and tenant_id filters are FORBIDDEN there.
 *
 * `clonePackToTenant` runs under the **assessiq_system** role (BYPASSRLS),
 * inside the transaction owned by the Phase-3 grant handler. RLS does NOT scope
 * these queries. They are DELIBERATELY cross-tenant: they READ the platform
 * (source) tenant's published pack and WRITE copies into the company (target)
 * tenant. Therefore every query here MUST filter by tenant_id / id explicitly —
 * that is the correct, required pattern for THIS file (because RLS is bypassed).
 *
 * This is the ONE sanctioned cross-tenant WRITE path in the codebase. The
 * company never gains a cross-tenant READ at runtime — it only ever reads its
 * own cloned rows through normal RLS. Invariants enforced below:
 *   - source pack must live in the platform tenant (slug='platform') and be
 *     status='published'
 *   - target tenant must differ from the platform tenant
 *   - a question whose non-null domain/category cannot be remapped into the
 *     target tenant's own taxonomy is SKIPPED and counted — never attached to a
 *     foreign-tenant UUID (which would later fail blueprint FK validation)
 *
 * The clone copies DATA only; the audit row is written by the caller (Phase 3)
 * after it switches back to the app role, per the two-phase grant tx pattern.
 */

export { type ClonePackResult } from "./clone/helpers.js";
export { clonePackToTenant, type MaterializeSetResult, materializeSetForTenant } from "./clone/clone-on-grant.js";
export { type ResyncResult } from "./clone/resync-types.js";
export { resyncClonedPack, resyncSetForTenant, listCloneTenantIdsForSource } from "./clone/resync.js";

