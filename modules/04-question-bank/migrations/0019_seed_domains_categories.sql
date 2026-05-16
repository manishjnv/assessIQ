-- owned by modules/04-question-bank
-- Seeds the 9-domain taxonomy + categories for ALL existing tenants.
--
-- WHY per-tenant seed (not global):
--   domains and categories carry tenant_id (RLS-enforced). There is no global
--   shared row. Each tenant gets its own copy so admin CRUD (Phase 2) is
--   isolated per tenant — one tenant reshaping their taxonomy does not affect
--   others. The seed runs once at migration time; future tenants get the seed
--   via onboarding logic (not this migration).
--
-- WHY no SET app.current_tenant:
--   RLS is the runtime access-control mechanism, not the migration mechanism.
--   Migrations run as a privileged role that bypasses RLS (assessiq_system or
--   the migration runner). We insert by explicit tenant_id, not by GUC.
--
-- Idempotency:
--   ON CONFLICT (tenant_id, slug) DO NOTHING             — domains
--   ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING  — categories
--   Re-running this migration is safe; existing rows are untouched.
--
-- relevance_score convention:
--   First-listed category in a domain = highest score (= count of categories
--   in that domain). Scores descend to 1 for the last-listed. Higher score =
--   sorted first in the wizard UI.
--
-- display_order on domains: sequential 1–9 matching listed order below.

-- ---------------------------------------------------------------------------
-- Domains (9)
-- ---------------------------------------------------------------------------

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'soc', 'SOC', 'active', 1
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'phishing', 'Phishing', 'active', 2
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'threat-intelligence', 'Threat Intelligence', 'active', 3
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'cloud-security', 'Cloud Security', 'active', 4
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'incident-response', 'Incident Response', 'active', 5
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'identity-access-mgmt', 'Identity & Access Mgmt', 'active', 6
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'devsecops', 'DevSecOps', 'active', 7
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'finance', 'Finance', 'active', 8
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

INSERT INTO domains (tenant_id, slug, name, status, display_order)
SELECT t.id, 'hr', 'HR', 'active', 9
FROM tenants t
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SOC categories (9; relevance_score 9 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'log-analysis', 'Log Analysis', 9, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'incident-triage', 'Incident Triage', 8, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'alert-investigation', 'Alert Investigation', 7, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'vulnerability-management', 'Vulnerability Management', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'phishing-analysis', 'Phishing Analysis', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'threat-hunting', 'Threat Hunting', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'siem-detection-engineering', 'SIEM / Detection Engineering', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'edr-xdr-response', 'EDR/XDR Response', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'mitre-attck-mapping', 'MITRE ATT&CK Mapping', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'soc'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Phishing categories (7; relevance_score 7 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'email-header-analysis', 'Email Header Analysis', 7, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'content-body-analysis', 'Content / Body Analysis', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'url-link-inspection', 'URL & Link Inspection', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'email-authentication', 'Email Authentication (SPF/DKIM/DMARC)', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'attachment-payload-analysis', 'Attachment / Payload Analysis', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'social-engineering-tactics', 'Social Engineering Tactics', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'reporting-response', 'Reporting & Response', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'phishing'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Threat Intelligence categories (6; relevance_score 6 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'ioc-analysis', 'IOC Analysis', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'threat-actor-profiling', 'Threat-Actor Profiling', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'ttp-mapping', 'TTP Mapping', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'osint', 'OSINT', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'malware-intelligence', 'Malware Intelligence', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'intel-reporting', 'Intel Reporting', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'threat-intelligence'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Cloud Security categories (6; relevance_score 6 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'iam-misconfiguration', 'IAM Misconfiguration', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'storage-exposure', 'Storage Exposure', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'network-security-groups', 'Network Security Groups', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'cloud-logging-monitoring', 'Cloud Logging & Monitoring', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'container-k8s-security', 'Container / K8s Security', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'cloud-incident-response', 'Cloud Incident Response', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'cloud-security'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Incident Response categories (6; relevance_score 6 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'containment', 'Containment', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'eradication', 'Eradication', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'forensics-evidence', 'Forensics & Evidence', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'root-cause-analysis', 'Root-Cause Analysis', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'recovery', 'Recovery', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'post-incident-review', 'Post-Incident Review', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'incident-response'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Identity & Access Mgmt categories (6; relevance_score 6 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'authentication', 'Authentication', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'authorization-rbac', 'Authorization / RBAC', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'privileged-access', 'Privileged Access', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'federation-sso', 'Federation / SSO', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'identity-lifecycle', 'Identity Lifecycle', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'access-reviews', 'Access Reviews', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'identity-access-mgmt'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- DevSecOps categories (6; relevance_score 6 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'secure-sdlc', 'Secure SDLC', 6, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'cicd-security', 'CI/CD Security', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'sast-dast', 'SAST / DAST', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'secrets-management', 'Secrets Management', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'iac-security', 'IaC Security', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'dependency-supply-chain', 'Dependency / Supply-Chain', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'devsecops'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Finance categories (5; relevance_score 5 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'fraud-detection', 'Fraud Detection', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'finance'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'risk-assessment', 'Risk Assessment', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'finance'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'compliance-sox-pci', 'Compliance (SOX / PCI)', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'finance'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'financial-analysis', 'Financial Analysis', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'finance'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'audit', 'Audit', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'finance'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- HR categories (5; relevance_score 5 → 1)
-- ---------------------------------------------------------------------------

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'behavioral', 'Behavioral', 5, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'hr'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'situational-judgement', 'Situational Judgement', 4, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'hr'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'policy-compliance', 'Policy & Compliance', 3, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'hr'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'conflict-resolution', 'Conflict Resolution', 2, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'hr'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;

INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected, supported_types, default_question_count, status)
SELECT t.id, d.id, 'talent-assessment', 'Talent Assessment', 1, true, '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb, 1, 'active'
FROM tenants t JOIN domains d ON d.tenant_id = t.id AND d.slug = 'hr'
ON CONFLICT (tenant_id, domain_id, slug) DO NOTHING;
