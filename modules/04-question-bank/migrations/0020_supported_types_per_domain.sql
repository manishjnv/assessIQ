-- owned by modules/04-question-bank
-- Sets per-domain supported_types on all categories for ALL tenants.
--
-- WHY this migration exists:
--   0019 seeded every category with all 5 types
--   '["mcq","scenario","subjective","kql","log_analysis"]'. The wizard was
--   therefore offering kql / log_analysis for HR, Finance, and Phishing
--   domains where those types are meaningless. This corrective migration
--   sets per-domain type sets per the intent defined in the 2.1a contract.
--
-- Domain → supported_types map (contract table):
--   soc              → mcq, scenario, subjective, kql, log_analysis
--   cloud-security   → mcq, scenario, subjective, kql, log_analysis
--   incident-response→ mcq, scenario, subjective, log_analysis
--   devsecops        → mcq, scenario, subjective, kql
--   threat-intelligence → mcq, scenario, subjective
--   phishing         → mcq, scenario, subjective, log_analysis
--   identity-access-mgmt → mcq, scenario, subjective
--   finance          → mcq, scenario, subjective
--   hr               → mcq, scenario, subjective
--
-- Idempotency:
--   Each UPDATE sets the same value every time. Re-running is safe; it
--   produces no change after the first application.
--
-- Scope:
--   Data-only. No schema change. All tenants are updated via the
--   categories→domains join on domain_id (tenant_id is on both tables;
--   the join is FK-safe without RLS involvement).

-- ---------------------------------------------------------------------------
-- soc — kql + log_analysis remain (SOC is the primary KQL/log domain)
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'soc';

-- ---------------------------------------------------------------------------
-- cloud-security — kql + log_analysis remain (cloud audit logs + KQL queries)
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective","kql","log_analysis"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'cloud-security';

-- ---------------------------------------------------------------------------
-- incident-response — log_analysis retained, kql removed
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective","log_analysis"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'incident-response';

-- ---------------------------------------------------------------------------
-- devsecops — kql retained (pipeline queries), log_analysis removed
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective","kql"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'devsecops';

-- ---------------------------------------------------------------------------
-- threat-intelligence — conceptual domain; no kql or log_analysis
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'threat-intelligence';

-- ---------------------------------------------------------------------------
-- phishing — log_analysis retained (email log/header review), kql removed
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective","log_analysis"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'phishing';

-- ---------------------------------------------------------------------------
-- identity-access-mgmt — conceptual/policy domain; no kql or log_analysis
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'identity-access-mgmt';

-- ---------------------------------------------------------------------------
-- finance — no kql or log_analysis (non-technical audit / GRC domain)
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'finance';

-- ---------------------------------------------------------------------------
-- hr — no kql or log_analysis (behavioural / HR domain)
-- ---------------------------------------------------------------------------

UPDATE categories
SET supported_types = '["mcq","scenario","subjective"]'::jsonb
FROM domains
WHERE categories.domain_id = domains.id
  AND domains.slug = 'hr';
