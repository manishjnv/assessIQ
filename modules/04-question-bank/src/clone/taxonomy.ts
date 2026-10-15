import { type PoolClient } from "pg";
import { linkPlatformCategories, linkPlatformDomain } from "../taxonomy-nodes.js";
import { uniqueNonNull } from "./helpers.js";

// ---------------------------------------------------------------------------
// provisionPlatformTaxonomyForQuestions — self-heal taxonomy gaps before copy
// ---------------------------------------------------------------------------
//
// A licensed pack's questions are tagged with the PLATFORM tenant's domains +
// categories. A target tenant only receives platform taxonomy that existed at
// its creation (seedTenantTaxonomy → seedFromPlatform) plus later platform
// DOMAIN propagation (platform-domains.ts createPlatformDomain). Platform
// CATEGORIES created after a tenant exists never propagate — so a question
// tagged to such a category used to be SILENTLY dropped by the slug-based
// taxonomy remap below (clonePackToTenant + buildTaxonomyResolver skip paths),
// leaving the clone short of (or entirely without) questions.
//
//   RCA 2026-05-26: WIPRO-SOC cloned "Application Security"; the 5 source
//   questions were tagged category 'waf', which existed only on the platform.
//   The clone copied 0 questions (skipped_count=5) → "pool too small: 0 < 5".
//
// This provisions exactly the platform domains/categories the source questions
// reference into the target tenant (idempotent, source='platform'), mirroring
// seed.ts seedFromPlatform. After it runs, the remap resolves every
// platform-sourced tag, so no licensed question is lost.
//
// GUARD (mirrors seed.ts): a platform category is only attached under a target
// domain that is itself source='platform'. A tenant-LOCAL domain sharing the
// slug is never given platform categories — such a question still falls through
// to the existing skip, preserving tenant-local taxonomy ownership.
//
// Runs under the caller's assessiq_system (BYPASSRLS) tx; writes the target
// tenant by explicit tenant_id (same trust model as the level/question inserts).
export async function provisionPlatformTaxonomyForQuestions(
  client: PoolClient,
  platformTenantId: string,
  targetTenantId: string,
  srcQuestions: Array<{ domain_id: string | null; category_id: string | null }>,
): Promise<void> {
  const domainIds = uniqueNonNull(srcQuestions.map((q) => q.domain_id));
  const catIds = uniqueNonNull(srcQuestions.map((q) => q.category_id));
  if (domainIds.length === 0 && catIds.length === 0) return;

  // All platform domains (small table) → id → {slug,name,description}.
  const platDomById = new Map<string, { slug: string; name: string; description: string | null }>();
  for (const r of (
    await client.query<{ id: string; slug: string; name: string; description: string | null }>(
      `SELECT id, slug, name, description FROM domains WHERE tenant_id = $1`,
      [platformTenantId],
    )
  ).rows) {
    platDomById.set(r.id, { slug: r.slug, name: r.name, description: r.description });
  }

  // Platform categories referenced by these questions (full attrs to copy).
  const srcCats =
    catIds.length > 0
      ? (
          await client.query<{
            id: string;
            slug: string;
            name: string;
            description: string | null;
            domain_id: string;
            relevance_score: number;
            default_selected: boolean;
            supported_types: unknown;
            default_question_count: number;
          }>(
            `SELECT id, slug, name, description, domain_id, relevance_score,
                    default_selected, supported_types, default_question_count
               FROM categories WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
            [catIds, platformTenantId],
          )
        ).rows
      : [];

  // Platform domains we need present in the target = questions' domain_id ∪
  // the referenced categories' own domain_id.
  const neededDomainIds = new Set<string>(domainIds);
  for (const c of srcCats) neededDomainIds.add(c.domain_id);

  // Target domains by slug (+ provenance).
  const tgtDomBySlug = new Map<string, { id: string; source: string }>();
  for (const r of (
    await client.query<{ id: string; slug: string; source: string }>(
      `SELECT id, slug, source FROM domains WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtDomBySlug.set(r.slug, { id: r.id, source: r.source });
  }

  // Provision any missing referenced platform domain (source='platform').
  for (const did of neededDomainIds) {
    const pd = platDomById.get(did);
    if (pd === undefined) continue; // not a platform domain → leave to remap/skip
    if (tgtDomBySlug.has(pd.slug)) continue; // already present (platform or tenant-local)
    const ins = (
      await client.query<{ id: string }>(
        `INSERT INTO domains (tenant_id, slug, name, description, source, status, display_order)
         VALUES ($1, $2, $3, $4, 'platform', 'active',
                 COALESCE((SELECT MAX(display_order) FROM domains WHERE tenant_id = $1), 0) + 1)
         ON CONFLICT (tenant_id, slug) DO NOTHING
         RETURNING id`,
        [targetTenantId, pd.slug, pd.name, pd.description],
      )
    ).rows[0];
    if (ins?.id !== undefined) {
      await linkPlatformDomain(client, ins.id, pd.slug); // RW-55
      tgtDomBySlug.set(pd.slug, { id: ins.id, source: "platform" });
    } else {
      // ON CONFLICT fired — a row with this slug already exists (e.g. a
      // tenant-LOCAL domain that raced in after the initial read). Re-read its
      // REAL id + source so the category guard below sees the true provenance
      // and never attaches platform categories under a tenant-local domain. If
      // it vanished (concurrent delete), leave it unprovisioned — the existing
      // remap/skip handles that question safely.
      const existing = (
        await client.query<{ id: string; source: string }>(
          `SELECT id, source FROM domains WHERE tenant_id = $1 AND slug = $2`,
          [targetTenantId, pd.slug],
        )
      ).rows[0];
      if (existing !== undefined) {
        tgtDomBySlug.set(pd.slug, { id: existing.id, source: existing.source });
      }
    }
  }

  if (srcCats.length === 0) return;

  // Existing target category keys (domainId::slug).
  const tgtCatKeys = new Set<string>();
  for (const r of (
    await client.query<{ slug: string; domain_id: string }>(
      `SELECT slug, domain_id FROM categories WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtCatKeys.add(`${r.domain_id}::${r.slug}`);
  }

  // Provision missing categories under their platform-origin target domain.
  for (const c of srcCats) {
    const pd = platDomById.get(c.domain_id);
    if (pd === undefined) continue;
    const tgtDom = tgtDomBySlug.get(pd.slug);
    // Never attach platform categories under a tenant-LOCAL domain (seed guard).
    if (tgtDom === undefined || tgtDom.source !== "platform") continue;
    const key = `${tgtDom.id}::${c.slug}`;
    if (tgtCatKeys.has(key)) continue;
    await client.query(
      `INSERT INTO categories
         (tenant_id, domain_id, slug, name, description, relevance_score,
          default_selected, supported_types, default_question_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active')
       ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING`,
      [
        targetTenantId,
        tgtDom.id,
        c.slug,
        c.name,
        c.description,
        c.relevance_score,
        c.default_selected,
        JSON.stringify(c.supported_types),
        c.default_question_count,
      ],
    );
    tgtCatKeys.add(key);
    // RW-55: link the new platform-source category to its NULL-tenant node.
    const dn = await client.query<{ node_id: string | null }>(`SELECT node_id FROM domains WHERE id = $1`, [tgtDom.id]);
    await linkPlatformCategories(client, tgtDom.id, dn.rows[0]?.node_id ?? null);
  }
}

/**
 * Build a taxonomy resolver (master domain/category id → target tenant id) by
 * SLUG — same semantics as clonePackToTenant: a non-null domain that has no
 * matching target domain (or a non-null category with no match) is unresolvable
 * and the question is skipped. MUST run under assessiq_system (reads platform +
 * target across tenants). Self-heals missing platform taxonomy first (see
 * provisionPlatformTaxonomyForQuestions) so platform-sourced tags resolve.
 */
export async function buildTaxonomyResolver(
  client: PoolClient,
  platformTenantId: string,
  targetTenantId: string,
  srcQuestions: Array<{ domain_id: string | null; category_id: string | null }>,
): Promise<
  (
    domainId: string | null,
    categoryId: string | null,
  ) => { ok: true; domainId: string | null; categoryId: string | null } | { ok: false }
> {
  // Self-heal: ensure the platform taxonomy these questions reference exists in
  // the target tenant BEFORE the maps below are built, so the resolver resolves
  // platform-sourced tags instead of returning {ok:false} (silent skip).
  await provisionPlatformTaxonomyForQuestions(client, platformTenantId, targetTenantId, srcQuestions);

  const srcDomainSlugById = new Map<string, string>();
  const srcDomainIds = uniqueNonNull(srcQuestions.map((q) => q.domain_id));
  if (srcDomainIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM domains WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcDomainIds, platformTenantId],
      )
    ).rows) {
      srcDomainSlugById.set(row.id, row.slug);
    }
  }
  const srcCatSlugById = new Map<string, string>();
  const srcCatIds = uniqueNonNull(srcQuestions.map((q) => q.category_id));
  if (srcCatIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM categories WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcCatIds, platformTenantId],
      )
    ).rows) {
      srcCatSlugById.set(row.id, row.slug);
    }
  }
  const tgtDomainIdBySlug = new Map<string, string>();
  for (const row of (
    await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM domains WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtDomainIdBySlug.set(row.slug, row.id);
  }
  const tgtCatIdByKey = new Map<string, string>();
  for (const row of (
    await client.query<{ id: string; slug: string; domain_id: string }>(
      `SELECT id, slug, domain_id FROM categories WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtCatIdByKey.set(`${row.domain_id}::${row.slug}`, row.id);
  }

  return (domainId, categoryId) => {
    if (domainId === null) return { ok: true, domainId: null, categoryId: null };
    const dslug = srcDomainSlugById.get(domainId);
    const tgtDom = dslug !== undefined ? tgtDomainIdBySlug.get(dslug) : undefined;
    if (tgtDom === undefined) return { ok: false };
    if (categoryId === null) return { ok: true, domainId: tgtDom, categoryId: null };
    const cslug = srcCatSlugById.get(categoryId);
    const tgtCat = cslug !== undefined ? tgtCatIdByKey.get(`${tgtDom}::${cslug}`) : undefined;
    if (tgtCat === undefined) return { ok: false };
    return { ok: true, domainId: tgtDom, categoryId: tgtCat };
  };
}

/** Stable JSON for content/rubric equality (jsonb returns key-sorted objects). */
export function stableJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/**
 * In-place content refresh of an existing clone from its (newer) master version.
 * MUST be called with `client` already in the `assessiq_system` role inside the
 * caller's transaction. Idempotent: if the clone is already at/above the master
 * version it returns `updated:false` and writes nothing.
 */
