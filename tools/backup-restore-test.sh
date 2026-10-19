#!/usr/bin/env bash
# Backup-and-restore test for the AssessIQ Postgres on the shared VPS.
# Runs from the laptop (Git Bash) and drives the VPS over `ssh assessiq-vps`.
#
# Usage: bash tools/backup-restore-test.sh [--dry-run] [--keep]
#   --dry-run  print the remote commands only; makes NO ssh call.
#   --keep     skip cleanup (debugging). Remove by hand: see docs/runbooks/backup-restore.md.
#
# What it does: pg_dump of assessiq-postgres (read-only) into a 0700 dir on the VPS,
# restore into a throwaway container assessiq-restore-test (own volume, --network none,
# random password never printed), compare row counts, then remove everything it created.
# It NEVER writes to assessiq-postgres and never copies the dump off the VPS.
#
# Count rules (production keeps changing between the dump and the count):
#   - schema_migrations, tenants, users, assessments: restore count must EQUAL production.
#   - attempts, audit_log: restore count must be <= production (rows added after the dump).
#   Any other result = MISMATCH and exit code 1.
#
# Exit codes: 0 pass, 1 count mismatch, 2 preflight/usage error, other = step failed.
set -euo pipefail

HOST="assessiq-vps"
PROD="assessiq-postgres"
CTR="assessiq-restore-test"
VOL="assessiq-restore-test-data"
DIR="/srv/assessiq/tmp-backup-test"
PGUSER="assessiq"
PGDB="assessiq"
TABLES="tenants users assessments attempts audit_log schema_migrations"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$DIR/$TS.dump"

DRY=0; KEEP=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# Names we may create/delete. Anything else is refused.
for n in "$CTR" "$PROD"; do
  case "$n" in assessiq-*) ;; *) echo "refusing non assessiq- name: $n" >&2; exit 2 ;; esac
done
[ "$CTR" != "$PROD" ] || { echo "restore target equals production" >&2; exit 2; }

# vps <label> <script>: run script on the VPS via ssh (stdin), or print it in dry-run.
# Variables are passed in as a prefix so the script bodies stay single-quoted.
PRE="set -euo pipefail; PROD='$PROD'; CTR='$CTR'; VOL='$VOL'; DIR='$DIR'; DUMP='$DUMP'; PGUSER='$PGUSER'; PGDB='$PGDB'; TABLES='$TABLES';"
vps() {
  if [ "$DRY" = 1 ]; then
    printf '[dry-run] %s\n---\n%s\n---\n' "$1" "$2"
    return 0
  fi
  ssh -o BatchMode=yes "$HOST" 'bash -s' <<<"$PRE $2"
}

# ---- cleanup: only removes what THIS run created ----
MADE_CTR=0; MADE_VOL=0; MADE_DUMP=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$KEEP" = 1 ]; then
    echo "KEEP set: not cleaning. Remove by hand: docker rm -f $CTR; docker volume rm $VOL; rm -f $DUMP; rmdir $DIR" >&2
    exit "$rc"
  fi
  local s="set +e;"
  [ "$MADE_CTR" = 1 ] && s="$s docker rm -f \"\$CTR\" >/dev/null;"
  [ "$MADE_VOL" = 1 ] && s="$s docker volume rm \"\$VOL\" >/dev/null;"
  [ "$MADE_DUMP" = 1 ] && s="$s rm -f \"\$DUMP\";"
  # rmdir only succeeds when empty, so it can never delete other files.
  s="$s rmdir \"\$DIR\" 2>/dev/null; exit 0"
  echo "== cleanup =="
  vps "cleanup" "$s" || echo "WARN cleanup failed, check the VPS by hand" >&2
  exit "$rc"
}
trap cleanup EXIT

echo "== 1. preflight (read-only) =="
vps "preflight" '
[ "$(docker inspect -f "{{.State.Health.Status}}" "$PROD")" = healthy ] || { echo "ABORT $PROD not healthy"; exit 2; }
if docker inspect "$CTR" >/dev/null 2>&1; then echo "ABORT container $CTR already exists (not ours, not deleting)"; exit 2; fi
if docker volume inspect "$VOL" >/dev/null 2>&1; then echo "ABORT volume $VOL already exists (not ours, not deleting)"; exit 2; fi
dbsize=$(docker exec "$PROD" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT pg_database_size(current_database())")
need=$((dbsize * 3))
for p in /srv/assessiq /var/lib/docker; do
  avail=$(df -B1 --output=avail "$p" | tail -1 | tr -d " ")
  [ "$avail" -ge "$need" ] || { echo "ABORT low disk on $p: avail=$avail need=$need"; exit 2; }
done
echo "OK db_bytes=$dbsize need_bytes=$need"
'

echo "== 2. dump =="
MADE_DUMP=1
OUT_DUMP="$(vps "dump" '
mkdir -p "$DIR"; chmod 700 "$DIR"
t0=$(date +%s)
docker exec "$PROD" pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$DUMP"
t1=$(date +%s)
chmod 600 "$DUMP"
echo "DUMP_SECS=$((t1 - t0)) DUMP_BYTES=$(stat -c %s "$DUMP")"
')"
echo "$OUT_DUMP"

echo "== 3. restore into $CTR =="
MADE_CTR=1; MADE_VOL=1
OUT_RESTORE="$(vps "restore" '
IMG=$(docker inspect -f "{{.Config.Image}}" "$PROD")
PW=$(openssl rand -hex 24)
docker volume create "$VOL" >/dev/null
# no published ports, no env_file, no production network; password never printed
docker run -d --name "$CTR" --network none -v "$VOL":/var/lib/postgresql/data \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_DB="$PGDB" -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null
unset PW
for i in $(seq 1 60); do
  docker exec "$CTR" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$CTR" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null || { echo "ABORT restore container not ready"; exit 3; }
# Roles the dump references (RLS policies use them). Production creates them in migration 0002_rls_helpers.sql.
docker exec "$CTR" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -q -c "CREATE ROLE assessiq_app NOLOGIN; CREATE ROLE assessiq_system NOLOGIN BYPASSRLS;" >/dev/null
t0=$(date +%s)
set +e
docker exec -i "$CTR" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --no-privileges < "$DUMP" 2> "$DIR/restore.err"
rc=$?
set -e
t1=$(date +%s)
errs=$(grep -c "^pg_restore: error" "$DIR/restore.err" || true)
echo "RESTORE_SECS=$((t1 - t0)) RESTORE_RC=$rc RESTORE_ERRORS=$errs"
# error lines name objects, not row data; show at most 3, truncated
grep "^pg_restore: error" "$DIR/restore.err" | head -3 | cut -c1-200 || true
rm -f "$DIR/restore.err"
')"
echo "$OUT_RESTORE"

echo "== 4. row counts =="
OUT_COUNTS="$(vps "counts (read-only SELECT count(*))" '
for t in $TABLES; do
  p=$(docker exec "$PROD" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT count(*) FROM $t")
  r=$(docker exec "$CTR" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT count(*) FROM $t")
  echo "COUNT $t $p $r"
done
')"

VERDICT=PASS; [ "$DRY" = 1 ] && VERDICT=DRY-RUN
printf '%-18s %10s %10s  %s\n' table prod restore result
if [ "$DRY" = 1 ]; then
  echo "(dry-run: no counts)"
else
  while read -r _ t p r; do
    case "$t" in attempts|audit_log) [ "$r" -le "$p" ] && res=MATCH || res=MISMATCH ;;
                 *) [ "$r" -eq "$p" ] && res=MATCH || res=MISMATCH ;;
    esac
    [ "$res" = MATCH ] || VERDICT=FAIL
    printf '%-18s %10s %10s  %s\n' "$t" "$p" "$r" "$res"
  done < <(grep '^COUNT ' <<<"$OUT_COUNTS")
  [ -n "$OUT_COUNTS" ] || VERDICT=FAIL
  grep -q 'RESTORE_ERRORS=0' <<<"$OUT_RESTORE" || echo "WARN pg_restore reported errors (see lines above); counts decide the verdict"
fi

echo "== summary =="
echo "dump:    $OUT_DUMP"
echo "restore: $(grep -o 'RESTORE_SECS=[0-9]* RESTORE_RC=[0-9]* RESTORE_ERRORS=[0-9]*' <<<"$OUT_RESTORE" || true)"
echo "verdict: $VERDICT"
[ "$DRY" = 1 ] || [ "$VERDICT" = PASS ] || exit 1
