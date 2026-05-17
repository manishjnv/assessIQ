// modules/04-question-bank/src/seed.ts
//
// seedTenantTaxonomy — C5 of the super-admin-onboarding contract.
//
// Seeds the 9-domain taxonomy + per-domain categories for a single tenant.
// Called by the C4 createCompany route immediately after createTenant.
//
// Single source of truth: values are extracted verbatim from:
//   - modules/04-question-bank/migrations/0019_seed_domains_categories.sql
//     (domain slugs/names/display_order, category slugs/names/relevance_score/
//     default_selected/default_question_count)
//   - modules/04-question-bank/migrations/0020_supported_types_per_domain.sql
//     (per-domain supported_types correction — replaces the all-types default
//     from 0019 with the correct per-domain subset)
//
// Idempotency: ON CONFLICT DO NOTHING on every INSERT. Running this function
// more than once for the same tenantId is safe and produces no duplicate rows.
//
// Cross-tenant safety: withTenant(tenantId) scopes ALL writes to the target
// tenant via RLS + SET LOCAL app.current_tenant. This function MUST NOT be
// called with the super-admin's own (platform) tenantId as the argument.
//
// Load-bearing-light (per contract): Opus diff review required before deploy.

import { withTenant } from "@assessiq/tenancy";
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
// Internal helpers — run inside an already-open withTenant transaction
// ---------------------------------------------------------------------------

async function seedDomain(
  client: PoolClient,
  tenantId: string,
  domain: DomainSeed,
): Promise<string> {
  // INSERT domain row (idempotent).
  const domainRes = await client.query<{ id: string }>(
    `INSERT INTO domains (tenant_id, slug, name, status, display_order)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (tenant_id, slug) DO NOTHING
     RETURNING id`,
    [tenantId, domain.slug, domain.name, domain.display_order],
  );

  // If DO NOTHING fired (row already existed), fetch the existing id.
  let domainId: string;
  if (domainRes.rows.length > 0) {
    domainId = domainRes.rows[0]!.id;
  } else {
    const existingRes = await client.query<{ id: string }>(
      `SELECT id FROM domains WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, domain.slug],
    );
    domainId = existingRes.rows[0]!.id;
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the 9-domain taxonomy for a single tenant.
 *
 * Uses withTenant(tenantId) — all writes are RLS-scoped to the target tenant.
 * Idempotent: ON CONFLICT DO NOTHING on every INSERT.
 *
 * Cross-tenant safety: MUST be called with the new company's tenantId, never
 * with the platform tenantId. The route (C4) is responsible for passing the
 * correct tenantId.
 *
 * Values are extracted verbatim from:
 *   0019_seed_domains_categories.sql (domains + categories baseline)
 *   0020_supported_types_per_domain.sql (per-domain supported_types correction)
 */
export async function seedTenantTaxonomy(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    for (const domain of DOMAINS) {
      await seedDomain(client, tenantId, domain);
    }
  });
}
