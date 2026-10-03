#!/usr/bin/env bash
# Apply every migration and the e2e seed to an EMPTY database. Run from the repo root.
#   PSQL="psql postgres://postgres:pw@localhost:5432/assessiq" bash apps/web/e2e/seed-db.sh
# Used by local-stack.sh and the CI e2e job. Reads SQL on stdin, so PSQL may be `docker exec -i ... psql`.
set -euo pipefail
: "${PSQL:?set PSQL to a psql command line}"

# Plain basename order runs 0010 before `users` exists, so use the dependency order of
# tools/test-support/apply-all-migrations.ts (five numbers are used twice; all files apply).
KEY='{n=$NF; sub(/_.*/,"",n); g=(n+0<=4)?0:(length(n)==3?((n+0>=20)?1:2):3); printf "%d %06d %s\t%s\n", g, n, $NF, $0}'
for f in $(find modules -path '*/migrations/*.sql' -not -path '*/node_modules/*' | awk -F/ "$KEY" | LC_ALL=C sort | cut -f2); do
  $PSQL -v ON_ERROR_STOP=1 -q < "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }
done

# Company tenant (internal plan = no licence gate) + its admin. The platform tenant and the
# super admin (manishjnvk@gmail.com) come from migration 016.
$PSQL -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
INSERT INTO tenants (id, slug, name, status) VALUES ('00000000-0000-0000-0000-0000000e2e01', 'wipro-soc', 'E2E Company', 'active');
INSERT INTO tenant_settings (tenant_id) VALUES ('00000000-0000-0000-0000-0000000e2e01');
INSERT INTO tenant_plans (tenant_id, tier) VALUES ('00000000-0000-0000-0000-0000000e2e01', 'internal');
INSERT INTO users (tenant_id, email, name, role, status)
  VALUES ('00000000-0000-0000-0000-0000000e2e01', 'e2e-admin@test.assessiq', 'E2E Admin', 'admin', 'active');
SQL
