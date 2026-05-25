// modules/04-question-bank/src/seed.ts
//
// seedTenantTaxonomy — C5 of the super-admin-onboarding contract.
//
// Seeds the domain taxonomy + per-domain categories for a single (new company)
// tenant. Called by the C4 createCompany route immediately after createTenant.
//
// PRIMARY: copies the PLATFORM master tenant's CURRENT active domains +
// categories (source='platform'), so every new tenant inherits the live
// platform domain set — including any domain a super-admin added via platform
// domain management, and excluding any that were archived. This replaces the
// old behavior of seeding the static hardcoded 0019 list, which could not
// reflect platform changes made after 0019 ran.
//
// FALLBACK: the hardcoded DOMAINS baseline below (values verbatim from
// 0019_seed_domains_categories.sql + 0020_supported_types_per_domain.sql) is
// used ONLY when no platform tenant exists yet (fresh DB before the manual
// platform bootstrap) so a new tenant is never left with zero domains.
//
// Transaction: runs as a single assessiq_system (BYPASSRLS) tx — reads the
// platform tenant, writes the target tenant by explicit tenant_id.
//
// Idempotency: ON CONFLICT DO NOTHING on every INSERT. Running this function
// more than once for the same tenantId is safe and produces no duplicate rows.
//
// Cross-tenant safety: MUST be called with the NEW company's tenantId, never the
// platform tenantId — guarded explicitly (throws). The platform tenant's own
// taxonomy is owned by migration 0083 + platform domain management.
//
// Load-bearing (cross-tenant + provisioning path): Opus diff review +
// codex:rescue gate required before deploy.

import { getPool } from "@assessiq/tenancy";
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Per-domain supported_types — from 0020_supported_types_per_domain.sql
// ---------------------------------------------------------------------------

// Domain slug → supported_types array (exact values from 0020 migration).
const DOMAIN_SUPPORTED_TYPES: Record<string, string[]> = {
  "soc":                   ["mcq", "scenario", "subjective", "kql", "log_analysis"],
  "phishing":              ["mcq", "scenario", "subjective", "log_analysis"],
  "threat-intelligence":   ["mcq", "scenario", "subjective"],
  "cloud-security":        ["mcq", "scenario", "subjective", "kql", "log_analysis"],
  "incident-response":     ["mcq", "scenario", "subjective", "log_analysis"],
  "identity-access-mgmt":  ["mcq", "scenario", "subjective"],
  "devsecops":             ["mcq", "scenario", "subjective", "kql"],
  "finance":               ["mcq", "scenario", "subjective"],
  "hr":                    ["mcq", "scenario", "subjective"],
};

// ---------------------------------------------------------------------------
// Domain seed data — from 0019_seed_domains_categories.sql
// ---------------------------------------------------------------------------

interface DomainSeed {
  slug: string;
  name: string;
  display_order: number;
  categories: CategorySeed[];
}

interface CategorySeed {
  slug: string;
  name: string;
  relevance_score: number;
  default_selected: boolean;
  default_question_count: number;
}

// Values extracted verbatim from 0019 + 0020. Single source of truth.
const DOMAINS: DomainSeed[] = [
  {
    slug: "soc",
    name: "SOC",
    display_order: 1,
    categories: [
      { slug: "log-analysis",              name: "Log Analysis",              relevance_score: 9, default_selected: true, default_question_count: 1 },
      { slug: "incident-triage",           name: "Incident Triage",           relevance_score: 8, default_selected: true, default_question_count: 1 },
      { slug: "alert-investigation",       name: "Alert Investigation",       relevance_score: 7, default_selected: true, default_question_count: 1 },
      { slug: "vulnerability-management",  name: "Vulnerability Management",  relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "phishing-analysis",         name: "Phishing Analysis",         relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "threat-hunting",            name: "Threat Hunting",            relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "siem-detection-engineering",name: "SIEM / Detection Engineering", relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "edr-xdr-response",          name: "EDR/XDR Response",          relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "mitre-attck-mapping",       name: "MITRE ATT&CK Mapping",      relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "phishing",
    name: "Phishing",
    display_order: 2,
    categories: [
      { slug: "email-header-analysis",       name: "Email Header Analysis",              relevance_score: 7, default_selected: true, default_question_count: 1 },
      { slug: "content-body-analysis",       name: "Content / Body Analysis",            relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "url-link-inspection",         name: "URL & Link Inspection",              relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "email-authentication",        name: "Email Authentication (SPF/DKIM/DMARC)", relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "attachment-payload-analysis", name: "Attachment / Payload Analysis",      relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "social-engineering-tactics",  name: "Social Engineering Tactics",         relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "reporting-response",          name: "Reporting & Response",               relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "threat-intelligence",
    name: "Threat Intelligence",
    display_order: 3,
    categories: [
      { slug: "ioc-analysis",           name: "IOC Analysis",          relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "threat-actor-profiling", name: "Threat-Actor Profiling",relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "ttp-mapping",            name: "TTP Mapping",           relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "osint",                  name: "OSINT",                 relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "malware-intelligence",   name: "Malware Intelligence",  relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "intel-reporting",        name: "Intel Reporting",       relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "cloud-security",
    name: "Cloud Security",
    display_order: 4,
    categories: [
      { slug: "iam-misconfiguration",      name: "IAM Misconfiguration",      relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "storage-exposure",          name: "Storage Exposure",          relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "network-security-groups",   name: "Network Security Groups",   relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "cloud-logging-monitoring",  name: "Cloud Logging & Monitoring",relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "container-k8s-security",    name: "Container / K8s Security",  relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "cloud-incident-response",   name: "Cloud Incident Response",   relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "incident-response",
    name: "Incident Response",
    display_order: 5,
    categories: [
      { slug: "containment",         name: "Containment",         relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "eradication",         name: "Eradication",         relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "forensics-evidence",  name: "Forensics & Evidence",relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "root-cause-analysis", name: "Root-Cause Analysis", relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "recovery",            name: "Recovery",            relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "post-incident-review",name: "Post-Incident Review",relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "identity-access-mgmt",
    name: "Identity & Access Mgmt",
    display_order: 6,
    categories: [
      { slug: "authentication",      name: "Authentication",       relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "authorization-rbac",  name: "Authorization / RBAC", relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "privileged-access",   name: "Privileged Access",    relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "federation-sso",      name: "Federation / SSO",     relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "identity-lifecycle",  name: "Identity Lifecycle",   relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "access-reviews",      name: "Access Reviews",       relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "devsecops",
    name: "DevSecOps",
    display_order: 7,
    categories: [
      { slug: "secure-sdlc",              name: "Secure SDLC",             relevance_score: 6, default_selected: true, default_question_count: 1 },
      { slug: "cicd-security",            name: "CI/CD Security",          relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "sast-dast",                name: "SAST / DAST",             relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "secrets-management",       name: "Secrets Management",      relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "iac-security",             name: "IaC Security",            relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "dependency-supply-chain",  name: "Dependency / Supply-Chain",relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "finance",
    name: "Finance",
    display_order: 8,
    categories: [
      { slug: "fraud-detection",   name: "Fraud Detection",      relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "risk-assessment",   name: "Risk Assessment",      relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "compliance-sox-pci",name: "Compliance (SOX / PCI)",relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "financial-analysis",name: "Financial Analysis",   relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "audit",             name: "Audit",                relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
  {
    slug: "hr",
    name: "HR",
    display_order: 9,
    categories: [
      { slug: "behavioral",          name: "Behavioral",          relevance_score: 5, default_selected: true, default_question_count: 1 },
      { slug: "situational-judgement",name: "Situational Judgement",relevance_score: 4, default_selected: true, default_question_count: 1 },
      { slug: "policy-compliance",   name: "Policy & Compliance", relevance_score: 3, default_selected: true, default_question_count: 1 },
      { slug: "conflict-resolution", name: "Conflict Resolution", relevance_score: 2, default_selected: true, default_question_count: 1 },
      { slug: "talent-assessment",   name: "Talent Assessment",   relevance_score: 1, default_selected: true, default_question_count: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Internal helpers — run inside an already-open assessiq_system transaction
// ---------------------------------------------------------------------------

async function seedDomainHardcoded(
  client: PoolClient,
  tenantId: string,
  domain: DomainSeed,
): Promise<string> {
  // INSERT domain row (idempotent). source='platform' — the hardcoded baseline
  // IS the platform taxonomy (this path only runs as the fresh-env fallback when
  // no platform tenant exists yet to copy from).
  const domainRes = await client.query<{ id: string }>(
    `INSERT INTO domains (tenant_id, slug, name, source, status, display_order)
     VALUES ($1, $2, $3, 'platform', 'active', $4)
     ON CONFLICT (tenant_id, slug) DO NOTHING
     RETURNING id`,
    [tenantId, domain.slug, domain.name, domain.display_order],
  );

  // If DO NOTHING fired (row already existed), fetch the existing id — but only
  // top up categories when that row is platform-origin. NEVER attach platform
  // categories to a tenant-LOCAL domain sharing this slug. (Defensive: this
  // fallback only runs on a brand-new tenant with no pre-existing domains, so a
  // collision is not expected — but the guard keeps a re-run safe.)
  let domainId: string;
  if (domainRes.rows.length > 0) {
    domainId = domainRes.rows[0]!.id;
  } else {
    const existingRes = await client.query<{ id: string; source: string }>(
      `SELECT id, source FROM domains WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, domain.slug],
    );
    const existing = existingRes.rows[0];
    if (existing === undefined || existing.source !== "platform") {
      return ""; // tenant-local collision — leave it untouched (caller ignores the id)
    }
    domainId = existing.id;
  }

  // Supported types for this domain (from 0020 correction).
  const supportedTypes = DOMAIN_SUPPORTED_TYPES[domain.slug] ?? ["mcq", "scenario", "subjective"];

  // INSERT categories (idempotent).
  for (const cat of domain.categories) {
    await client.query(
      `INSERT INTO categories
         (tenant_id, domain_id, slug, name, relevance_score, default_selected,
          supported_types, default_question_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active')
       ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING`,
      [
        tenantId,
        domainId,
        cat.slug,
        cat.name,
        cat.relevance_score,
        cat.default_selected,
        JSON.stringify(supportedTypes),
        cat.default_question_count,
      ],
    );
  }

  return domainId;
}

// ---------------------------------------------------------------------------
// Platform-sourced seeding (primary path)
// ---------------------------------------------------------------------------

/** Resolve the platform (master-library) tenant id by its well-known slug. */
async function getPlatformTenantId(client: PoolClient): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`,
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Copy the platform master tenant's ACTIVE domains + their categories into the
 * target tenant. This is the live source of truth, so a new tenant inherits any
 * domain a super-admin added via platform domain management — and never inherits
 * one that was archived. Domains are tagged source='platform'. Idempotent
 * (ON CONFLICT DO NOTHING). Returns the number of platform domains copied.
 *
 * Runs under the caller's assessiq_system transaction (BYPASSRLS) so it can read
 * the platform tenant while writing the target tenant.
 */
async function seedFromPlatform(
  client: PoolClient,
  targetTenantId: string,
  platformTenantId: string,
): Promise<number> {
  const domainsRes = await client.query<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    display_order: number;
  }>(
    `SELECT id, slug, name, description, display_order
       FROM domains
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY display_order ASC`,
    [platformTenantId],
  );

  for (const pd of domainsRes.rows) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO domains (tenant_id, slug, name, description, source, status, display_order)
       VALUES ($1, $2, $3, $4, 'platform', 'active', $5)
       ON CONFLICT (tenant_id, slug) DO NOTHING
       RETURNING id`,
      [targetTenantId, pd.slug, pd.name, pd.description, pd.display_order],
    );

    let targetDomainId: string;
    if (ins.rows.length > 0) {
      // Freshly inserted platform-origin domain.
      targetDomainId = ins.rows[0]!.id;
    } else {
      // Slug already existed in the target tenant. Only top-up categories if the
      // existing row is itself platform-origin; NEVER attach platform categories
      // to a tenant-LOCAL domain that happens to share this slug.
      const ex = await client.query<{ id: string; source: string }>(
        `SELECT id, source FROM domains WHERE tenant_id = $1 AND slug = $2`,
        [targetTenantId, pd.slug],
      );
      const existing = ex.rows[0];
      if (existing === undefined || existing.source !== "platform") {
        continue; // tenant-local collision — leave it untouched
      }
      targetDomainId = existing.id;
    }

    const catsRes = await client.query<{
      slug: string;
      name: string;
      description: string | null;
      relevance_score: number;
      default_selected: boolean;
      supported_types: unknown;
      default_question_count: number;
    }>(
      `SELECT slug, name, description, relevance_score, default_selected,
              supported_types, default_question_count
         FROM categories
        WHERE tenant_id = $1 AND domain_id = $2 AND status = 'active'`,
      [platformTenantId, pd.id],
    );

    for (const c of catsRes.rows) {
      await client.query(
        `INSERT INTO categories
           (tenant_id, domain_id, slug, name, description, relevance_score,
            default_selected, supported_types, default_question_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active')
         ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING`,
        [
          targetTenantId,
          targetDomainId,
          c.slug,
          c.name,
          c.description,
          c.relevance_score,
          c.default_selected,
          JSON.stringify(c.supported_types),
          c.default_question_count,
        ],
      );
    }
  }

  return domainsRes.rows.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the domain taxonomy for a single (new company) tenant.
 *
 * PRIMARY path: copy the PLATFORM master tenant's current ACTIVE domains +
 * categories (source='platform'). This keeps every tenant in sync with the live
 * platform domain set — a super-admin's platform create/archive flows through to
 * future tenants automatically (replaces the old hardcoded 0019 list, which
 * could not reflect post-0019 platform changes).
 *
 * FALLBACK path: if no platform tenant exists yet (fresh DB before the manual
 * platform bootstrap), seed the hardcoded DOMAINS baseline (verbatim from
 * 0019 + 0020). This guarantees a new tenant is never left with zero domains.
 *
 * Runs as a single assessiq_system (BYPASSRLS) transaction: reads the platform
 * tenant, writes the target tenant by explicit tenant_id. Idempotent
 * (ON CONFLICT DO NOTHING on every INSERT).
 *
 * Cross-tenant safety: MUST be called with the NEW company's tenantId, never the
 * platform tenantId — guarded explicitly (throws). The platform tenant's own
 * taxonomy is owned by migration 0083 + platform domain management, not this
 * per-company function.
 */
export async function seedTenantTaxonomy(tenantId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const platformTenantId = await getPlatformTenantId(client);
    if (platformTenantId !== null && platformTenantId === tenantId) {
      // Never seed the platform tenant into itself.
      throw new Error(
        "seedTenantTaxonomy must not be called with the platform tenant id",
      );
    }

    if (platformTenantId !== null) {
      // PRIMARY: copy the live platform domain set. If the platform tenant has
      // ZERO active domains (e.g. a super-admin archived them all), seed nothing
      // — that is the correct catalog-only outcome. Do NOT fall back to the
      // hardcoded baseline here: doing so would silently reintroduce archived
      // domains as active for every new tenant, defeating the archive.
      await seedFromPlatform(client, tenantId, platformTenantId);
    } else {
      // FALLBACK (fresh DB only): no platform tenant exists yet, before the
      // manual platform bootstrap → seed the hardcoded baseline so the new
      // tenant is never left with zero domains.
      for (const domain of DOMAINS) {
        await seedDomainHardcoded(client, tenantId, domain);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
