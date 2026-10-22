#!/usr/bin/env node
// AssessIQ - load-test teardown (Node 22, stdlib only).
//
// Emits ONE SQL transaction on stdout. Nothing is executed here: pipe the SQL to psql inside the Postgres
// container, connected as the DB OWNER role.
//
// USAGE
//   node tools/load-test/teardown-test-tenant.mjs --slug loadtest-<run-id> > teardown.sql
//   docker exec -i assessiq-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < teardown.sql
//   The first line of the SQL is a comment that names the slug. Read it before you run it.
//
// WHAT IT DOES (only rows whose tenant is the named test tenant)
//   1. Refuses (exit 2) unless the slug matches ^loadtest-[a-z0-9-]+$. The SQL repeats the guard and aborts
//      unless exactly one tenant matches the slug.
//   2. Sets tenants.status = 'archived' (the tenant row, tenant_settings and tenant_plans stay).
//   3. Deletes: gradings, attempts (cascades attempt_questions, attempt_answers, attempt_events,
//      attempt_scores, camera rows tied to attempts, certificates, billing_events, credit_burns),
//      consent_events, camera_consents, in_app_notifications, tenant_legal_acceptances, assessment_invitations,
//      assessment_frozen_pool, assessments, question_tags, question_source, question_versions, questions,
//      tags, levels, question_packs, tenant_candidate_counted, user_invitations, users (sessions cascade).
//   4. NEVER deletes or updates audit_log (append-only). It appends one 'tenant.archived' row.
//      Users that an audit_log row references (actor_user_id) are KEPT, because the foreign key
//      forbids their deletion. The SQL prints how many users were kept.
//   5. Never touches any other tenant: every statement filters on the tenant id of the slug.
//
// ENV NEEDED: none.

const argv = process.argv.slice(2);
let slug;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--slug") slug = argv[++i];
  else {
    process.stderr.write(`teardown-test-tenant: unknown argument ${argv[i]}\nusage: --slug loadtest-<run-id>\n`);
    process.exit(2);
  }
}
if (typeof slug !== "string" || !/^loadtest-[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
  process.stderr.write("teardown-test-tenant: refusing: --slug must start with 'loadtest-' and use only a-z, 0-9, '-'\n");
  process.exit(2);
}

const S = `'${slug}'`; // safe: validated by the regex above
const T = `(SELECT id FROM _lt_tenant)`;
const sql = `-- loadtest teardown slug=${slug}
\\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _lt_tenant ON COMMIT DROP AS
  SELECT id FROM tenants WHERE slug = ${S} AND slug LIKE 'loadtest-%';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM _lt_tenant;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 loadtest tenant with slug ${slug}, found %', n; END IF;
END $$;

-- 1. archive the tenant (status check allows 'archived')
UPDATE tenants SET status = 'archived', updated_at = now() WHERE id = ${T};

-- 2. rows that hang off attempts or users without ON DELETE CASCADE
DELETE FROM gradings WHERE tenant_id = ${T};
DELETE FROM camera_consents WHERE tenant_id = ${T};
DELETE FROM consent_events WHERE tenant_id = ${T};
DELETE FROM in_app_notifications WHERE tenant_id = ${T};
DELETE FROM tenant_legal_acceptances WHERE tenant_id = ${T};

-- 3. attempts (cascade: attempt_questions, attempt_answers, attempt_events, attempt_scores, camera_files,
--    camera_attempt_reviews, certificates, billing_events, credit_burns)
DELETE FROM attempts WHERE tenant_id = ${T};

-- 4. assessments and their children (assessment_invitations and assessment_frozen_pool also cascade)
DELETE FROM assessment_invitations WHERE assessment_id IN (SELECT id FROM assessments WHERE tenant_id = ${T});
DELETE FROM assessment_frozen_pool WHERE tenant_id = ${T};
DELETE FROM assessments WHERE tenant_id = ${T};

-- 5. content: questions live under the tenant's packs (questions has no tenant_id column)
DELETE FROM question_tags WHERE question_id IN (SELECT q.id FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE p.tenant_id = ${T});
DELETE FROM question_source WHERE tenant_id = ${T};
DELETE FROM question_versions WHERE question_id IN (SELECT q.id FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE p.tenant_id = ${T});
DELETE FROM questions WHERE pack_id IN (SELECT id FROM question_packs WHERE tenant_id = ${T});
DELETE FROM tags WHERE tenant_id = ${T};
DELETE FROM levels WHERE pack_id IN (SELECT id FROM question_packs WHERE tenant_id = ${T});
DELETE FROM question_packs WHERE tenant_id = ${T};

-- 6. users. audit_log.actor_user_id has a foreign key and audit_log is append-only: keep referenced users.
DELETE FROM tenant_candidate_counted WHERE tenant_id = ${T};
DELETE FROM user_invitations WHERE tenant_id = ${T};
DELETE FROM users u WHERE u.tenant_id = ${T}
  AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_user_id = u.id);

-- 7. audit trail: append only, never deleted
INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after)
  SELECT id, 'system', 'tenant.archived', 'tenant', id,
         jsonb_build_object('slug', ${S}, 'source', 'tools/load-test/teardown-test-tenant.mjs')
    FROM _lt_tenant;

SELECT 'users kept (referenced by audit_log)' AS note, count(*) FROM users WHERE tenant_id = ${T};
COMMIT;
`;
process.stdout.write(sql);
