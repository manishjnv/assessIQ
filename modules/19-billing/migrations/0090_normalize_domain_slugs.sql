-- 0090_normalize_domain_slugs.sql
--
-- Normalize domain references to canonical lowercase slugs (matching the
-- `domains` table, whose slugs are already lowercase). Free-text pack-domain
-- entry and the old Grant dropdown (which read a tenant's OWN pack domains)
-- let mixed-case values like 'SOC' drift in. The licensing catalog matches an
-- entitlement's domain scope_id against platform pack.domain by EXACT string,
-- so an active 'SOC' entitlement silently matched no lowercase platform set.
--
-- Recurrence is now prevented at the write paths: the New-Pack domain dropdown
-- (A1) and the Grant dropdown sourced from the canonical `domains` table (A2),
-- plus grantEntitlement/revokeEntitlement lowercase domain scope_id. This
-- migration repairs the existing rows. Idempotent: a second run matches no
-- rows (everything is already lowercase) and finds no collisions.

-- 1) question_packs.domain -> lowercase. No unique constraint on domain, so a
--    straight lowercase is safe (multiple packs may share a domain).
UPDATE question_packs
   SET domain = lower(domain), updated_at = now()
 WHERE domain IS NOT NULL
   AND domain <> lower(domain);

-- 2) tenant_entitlements domain-scope scope_id -> lowercase. The UNIQUE
--    (tenant_id, scope_type, scope_id) constraint means lowercasing can collide
--    with an existing lowercase row (observed: wipro-soc has active 'SOC' +
--    revoked 'soc'). Resolve by keeping ONE winner per (tenant, lower(scope_id))
--    -- prefer status='active', then most-recently granted -- and deleting the
--    redundant losers BEFORE normalizing the survivors. Only domain-scope rows
--    are touched; pack-scope scope_ids are UUIDs and never collide on case.
WITH grp AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, scope_type, lower(scope_id)
           ORDER BY (status = 'active') DESC, granted_at DESC, id DESC
         ) AS rn
    FROM tenant_entitlements
   WHERE scope_type = 'domain'
)
DELETE FROM tenant_entitlements
 WHERE id IN (SELECT id FROM grp WHERE rn > 1);

UPDATE tenant_entitlements
   SET scope_id = lower(scope_id)
 WHERE scope_type = 'domain'
   AND scope_id <> lower(scope_id);
