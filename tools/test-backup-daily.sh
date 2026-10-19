#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2012,SC2010,SC2126
# Local proof for tools/backup-daily.sh. Needs: docker, age + age-keygen (PATH or AGE_DIR), image postgres:16-alpine.
# Usage: bash tools/test-backup-daily.sh
#   AGE_DIR=<dir with age and age-keygen>   use these binaries (they are never installed)
#   PG_IMAGE=postgres:16-alpine
# It creates two throwaway containers named assessiq-backuptest-<random>-src / -dst (no published ports),
# a temp dir with a throwaway age keypair, and a LOCAL directory as the off-site target (BACKUP_TARGET=local:).
# It removes only those names at the end. It never touches any other container.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite container paths

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/backup-daily.sh"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
RND="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
SRC="assessiq-backuptest-$RND-src"
DST="assessiq-backuptest-$RND-dst"
TMP="$(mktemp -d)"
FAILS=0

if [ -n "${AGE_DIR:-}" ]; then PATH="$AGE_DIR:$PATH"; fi
for t in docker age age-keygen sha256sum; do
  command -v "$t" >/dev/null 2>&1 || { echo "MISSING: $t (install nothing silently: set AGE_DIR or install it, then re-run)" >&2; exit 3; }
done
docker info >/dev/null 2>&1 || { echo "MISSING: a running Docker daemon" >&2; exit 3; }

cleanup() {
  local rc=$?
  trap - EXIT
  for n in "$SRC" "$DST"; do
    case "$n" in assessiq-backuptest-*) docker rm -f -v "$n" >/dev/null 2>&1 || true ;; esac
  done
  rm -rf "$TMP"
  echo "== cleanup done (containers $SRC, $DST, temp dir) =="
  exit "$rc"
}
trap cleanup EXIT

ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
check() { # check <label> <command...>
  local l="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$l"; else bad "$l"; fi
}

start_pg() { # start_pg <name>
  docker run -d --name "$1" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_USER=assessiq -e POSTGRES_DB=assessiq -e POSTGRES_PASSWORD="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')" \
    --health-cmd "pg_isready -U assessiq -d assessiq" --health-interval 2s --health-retries 30 "$PG_IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] && return 0
    sleep 2
  done
  echo "container $1 never became healthy" >&2; return 1
}
np() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; } # native Windows exe path
psql_in() { docker exec "$1" psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 -tAc "$2"; }

echo "== setup: throwaway keypair, source container $SRC =="
age-keygen > "$TMP/key.txt" 2>/dev/null
PUB="$(age-keygen -y < "$TMP/key.txt")"
KEYP="$(np "$TMP/key.txt")"
OFFSITE="$TMP/offsite"; mkdir -p "$OFFSITE"
start_pg "$SRC"
psql_in "$SRC" "CREATE TABLE tenants(id serial primary key, name text); INSERT INTO tenants(name) SELECT 'tenant-'||g FROM generate_series(1,6) g;
CREATE TABLE attempts(id serial primary key, payload text); INSERT INTO attempts(payload) SELECT md5(g::text) FROM generate_series(1,250) g;
CREATE TABLE audit_log(id serial primary key, note text); INSERT INTO audit_log(note) SELECT 'row'||g FROM generate_series(1,1000) g;" >/dev/null
TABLES="tenants attempts audit_log"

# Env for every run of the script under test. The alert hook records its message instead of sending email.
cat > "$TMP/alert-hook.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "$TMP/alerts.log"
EOF
chmod 755 "$TMP/alert-hook.sh"
cat > "$TMP/corrupt.sh" <<'EOF'
#!/usr/bin/env bash
# flip the last byte in place: same size, different hash
f="$1"; printf 'X' | dd of="$f" bs=1 seek=$(( $(stat -c %s "$f") - 1 )) conv=notrunc 2>/dev/null
EOF
chmod 755 "$TMP/corrupt.sh"

run_backup() { # run_backup [extra env assignments...] -- [script args]; output to $TMP/run.log
  env BACKUP_ENV_FILE="$TMP/none.env" BACKUP_TARGET="local:$OFFSITE" BACKUP_ALLOW_LOCAL=1 R2_PREFIX=assessiq \
      AGE_RECIPIENT="$PUB" PG_CONTAINER="$SRC" BACKUP_TMP="$TMP/work" STATUS_FILE="$TMP/status" \
      STATUS_FILE_FILES="$TMP/status-files" ALERT_HOOK="$TMP/alert-hook.sh" "$@" bash "$SCRIPT" > "$TMP/run.log" 2>&1
}
DAILY="$OFFSITE/assessiq/db/daily"

echo "== 1. happy path: dump, encrypt, upload, verify =="
: > "$TMP/alerts.log"
if run_backup KEEP_DAILY=7; then ok "script exit 0"; else bad "script exit 0"; sed 's/^/    /' "$TMP/run.log"; fi
OBJ="$(ls "$DAILY" | grep -E '^assessiq-[0-9]{8}T[0-9]{6}Z\.dump\.age$' | head -1 || true)"
check "encrypted object exists" test -n "$OBJ" -a -f "$DAILY/$OBJ"
check "sidecar .sha256 exists" test -f "$DAILY/$OBJ.sha256"
check "object starts with age header" test "$(head -c 21 "$DAILY/$OBJ")" = "age-encryption.org/v1"
check "object is NOT a pg dump (no PGDMP magic)" test "$(head -c 5 "$DAILY/$OBJ")" != "PGDMP"
check "object contains no plain row text" bash -c '! grep -aq "tenant-1" "$1"' _ "$DAILY/$OBJ"
check "sidecar matches sha256 of object" test "$(cut -d' ' -f1 "$DAILY/$OBJ.sha256")" = "$(sha256sum "$DAILY/$OBJ" | cut -d' ' -f1)"
check "status file says OK with size and sha" grep -Eq ' OK mode=db name=.* size=[0-9]+ sha256=[0-9a-f]{12} secs=[0-9]+' "$TMP/status"
check "no alert on success" test ! -s "$TMP/alerts.log"
check "work dir cleaned up" bash -c '[ -z "$(ls -A "$1" 2>/dev/null)" ]' _ "$TMP/work"
check "log never prints the age private key" bash -c '! grep -q "AGE-SECRET-KEY" "$1"' _ "$TMP/run.log"

echo "== 2. decrypt with the private key and restore into a second container =="
age -d -i "$KEYP" < "$DAILY/$OBJ" > "$TMP/restored.dump"
check "decrypted file is a pg custom dump" test "$(head -c 5 "$TMP/restored.dump")" = "PGDMP"
start_pg "$DST"
docker exec -i "$DST" pg_restore -U assessiq -d assessiq --no-owner --no-privileges < "$TMP/restored.dump" >/dev/null 2>&1 || true
for t in $TABLES; do
  a="$(psql_in "$SRC" "SELECT count(*) FROM $t")"; b="$(psql_in "$DST" "SELECT count(*) FROM $t")"
  if [ "$a" = "$b" ] && [ "$a" -gt 0 ]; then ok "row count $t src=$a restored=$b"; else bad "row count $t src=$a restored=$b"; fi
done

echo "== 3. negative: corrupt the uploaded object, verify must FAIL and alert =="
: > "$TMP/alerts.log"; rm -rf "$OFFSITE"; mkdir -p "$OFFSITE"
if run_backup TEST_AFTER_UPLOAD="$TMP/corrupt.sh"; then bad "corrupted upload must exit non-zero"; else ok "corrupted upload exits non-zero"; fi
check "log says verify FAILED" grep -q 'verify FAILED' "$TMP/run.log"
check "status file says FAIL" grep -q ' FAIL ' "$TMP/status"
check "alert hook was called with the failure" grep -q 'verify FAILED' "$TMP/alerts.log"
check "no retention ran after failed verify" test "$(ls "$DAILY" | wc -l)" -le 2

echo "== 4. retention: keep 3, only exact-pattern oldest removed =="
rm -rf "$OFFSITE"; mkdir -p "$DAILY"; : > "$TMP/alerts.log"
for d in 20200101 20200102 20200103 20200104 20200105 20200106; do
  echo x > "$DAILY/assessiq-${d}T000000Z.dump.age"; echo "s" > "$DAILY/assessiq-${d}T000000Z.dump.age.sha256"
done
for f in notes.txt assessiq-20190101T000000Z.dump.age.bak other-20190101T000000Z.dump.age assessiq-2019.dump.age assessiq-20190101T000000Z.tar.age; do echo keep > "$DAILY/$f"; done
run_backup KEEP_DAILY=3 || { bad "retention run exit 0"; sed 's/^/    /' "$TMP/run.log"; }
LEFT="$(ls "$DAILY" | grep -E '^assessiq-[0-9]{8}T[0-9]{6}Z\.dump\.age$' | wc -l)"
if [ "$LEFT" = 3 ]; then ok "3 matching objects left (7 existed, keep 3)"; else bad "expected 3 matching objects, found $LEFT"; fi
check "oldest 4 removed (20200101..04)" bash -c 'for d in 20200101 20200102 20200103 20200104; do [ ! -e "$1/assessiq-${d}T000000Z.dump.age" ] || exit 1; done' _ "$DAILY"
check "sidecars of removed objects removed" bash -c '[ ! -e "$1/assessiq-20200101T000000Z.dump.age.sha256" ]' _ "$DAILY"
check "newer seeded objects kept (20200105, 20200106)" bash -c '[ -e "$1/assessiq-20200105T000000Z.dump.age" ] && [ -e "$1/assessiq-20200106T000000Z.dump.age" ]' _ "$DAILY"
check "non-matching files untouched (5)" bash -c 'cd "$1" && for f in notes.txt assessiq-20190101T000000Z.dump.age.bak other-20190101T000000Z.dump.age assessiq-2019.dump.age assessiq-20190101T000000Z.tar.age; do [ -e "$f" ] || exit 1; done' _ "$DAILY"

echo "== 5. retention refuses to delete on an empty listing =="
mkdir -p "$TMP/empty/assessiq/db/daily"; : > "$TMP/alerts.log"
set +e
# shellcheck disable=SC1090,SC2034 # WORK/ALERTED are read by the sourced functions
( set +e
  source "$SCRIPT"; MODE=db; DRY=0; ALERTED=0
  export BACKUP_TARGET="local:$TMP/empty" R2_PREFIX=assessiq STATUS_FILE="$TMP/status2" ALERT_HOOK="$TMP/alert-hook.sh"
  WORK="$TMP"; prune db/daily '^assessiq-[0-9]{8}T[0-9]{6}Z\.dump\.age$' 3 assessiq-20990101T000000Z.dump.age ) > "$TMP/prune.log" 2>&1
PRC=$?
set -e
if [ "$PRC" -ne 0 ] && grep -q 'retention refused' "$TMP/prune.log"; then ok "empty listing: refused (rc=$PRC)"; else bad "empty listing must be refused (rc=$PRC)"; fi
check "empty listing raised an alert" grep -q 'retention refused' "$TMP/alerts.log"

echo "== 6. config guards =="
# shellcheck disable=SC2016
if env BACKUP_ENV_FILE="$TMP/loose.env" bash -c 'echo X=1 > "$BACKUP_ENV_FILE"; chmod 644 "$BACKUP_ENV_FILE"; exec bash "$0"' "$SCRIPT" >"$TMP/g.log" 2>&1; then
  bad "env file with mode 644 / non-root must be refused"
else
  if grep -q REFUSED "$TMP/g.log"; then ok "env file not (600 + root) refused"; else bad "env file refusal message missing"; fi
fi
if env BACKUP_ENV_FILE="$TMP/none.env" BACKUP_TARGET="local:$OFFSITE" BACKUP_ALLOW_LOCAL=1 AGE_RECIPIENT="$(grep AGE-SECRET-KEY "$TMP/key.txt")" \
     PG_CONTAINER="$SRC" STATUS_FILE="$TMP/status3" ALERT_HOOK="$TMP/alert-hook.sh" bash "$SCRIPT" >"$TMP/g2.log" 2>&1; then
  bad "private key as recipient must be refused"
else
  if grep -q 'PRIVATE key' "$TMP/g2.log"; then ok "private key as recipient refused"; else bad "private key refusal message missing"; fi
fi
# shellcheck disable=SC2016
check "container without assessiq- prefix refused" bash -c '! env BACKUP_ENV_FILE=/nonexistent BACKUP_TARGET=local:/x BACKUP_ALLOW_LOCAL=1 AGE_RECIPIENT=age1x PG_CONTAINER=postgres STATUS_FILE="$1" ALERT_HOOK=true bash "$2" >/dev/null 2>&1' _ "$TMP/status4" "$SCRIPT"

echo "== 7. --files: skip when path missing, upload when present =="
if env BACKUP_ENV_FILE="$TMP/none.env" BACKUP_TARGET="local:$OFFSITE" BACKUP_ALLOW_LOCAL=1 AGE_RECIPIENT="$PUB" PG_CONTAINER="$SRC" \
     BACKUP_TMP="$TMP/work" STATUS_FILE="$TMP/status" FILES_PATH="$TMP/nope" ALERT_HOOK="$TMP/alert-hook.sh" bash "$SCRIPT" --files 2>&1 | grep -q '^SKIP --files'; then
  ok "missing FILES_PATH prints a clear SKIP"; else bad "missing FILES_PATH must print SKIP"; fi
mkdir -p "$TMP/uploads"; echo "photo-bytes" > "$TMP/uploads/a.jpg"
if env BACKUP_ENV_FILE="$TMP/none.env" BACKUP_TARGET="local:$OFFSITE" BACKUP_ALLOW_LOCAL=1 AGE_RECIPIENT="$PUB" PG_CONTAINER="$SRC" \
     BACKUP_TMP="$TMP/work" STATUS_FILE="$TMP/status" STATUS_FILE_FILES="$TMP/status-files" FILES_PATH="$TMP/uploads" ALERT_HOOK="$TMP/alert-hook.sh" bash "$SCRIPT" --files >"$TMP/f.log" 2>&1; then
  FOBJ="$(cd "$OFFSITE/assessiq/files/daily" && echo ./*.tar.age)"
  if age -d -i "$KEYP" < "$OFFSITE/assessiq/files/daily/$FOBJ" | tar -tf - | grep -q 'uploads/a.jpg'; then ok "files archive decrypts and lists uploads/a.jpg"; else bad "files archive content"; fi
else bad "--files run"; sed 's/^/    /' "$TMP/f.log"; fi

echo "== 8. dry run makes no file or docker call =="
check "--dry-run exits 0" bash "$SCRIPT" --dry-run
check "--help exits 0" bash "$SCRIPT" --help

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL PASS"; else echo "RESULT: $FAILS FAILED"; exit 1; fi
