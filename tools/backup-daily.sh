#!/usr/bin/env bash
# Daily OFF-SITE backup of the AssessIQ Postgres (and optionally the uploaded files).
# Runs ON the VPS as root, from cron or a systemd timer (see docs/runbooks/backup-daily.md).
# It is ADDITIONAL to /etc/cron.daily/assessiq-backup (on-box dump). It never edits that job.
#
# Usage: backup-daily.sh [--files] [--dry-run] [--help]
#   (default)  pg_dump -Fc -> age (public key only) -> Cloudflare R2 -> verify -> retention
#   --files    tar of FILES_PATH -> age -> R2 -> verify -> retention (skips if path missing)
#   --dry-run  print every step and the commands it WOULD run; no docker/network/file write
#
# Config (root-only env file BACKUP_ENV_FILE, default /etc/assessiq/backup.env, mode 600, owner root;
# or plain environment). Names only, never values, are listed here:
#   BACKUP_TARGET     r2 (default) | local:<dir>   (local: needs BACKUP_ALLOW_LOCAL=1, tests only)
#   R2_ENDPOINT R2_BUCKET R2_PREFIX(assessiq) R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
#   AGE_RECIPIENT | AGE_RECIPIENT_FILE      PUBLIC key only. The private key never lives on the VPS.
#   KEEP_DAILY(7) KEEP_WEEKLY(4)  PG_CONTAINER(assessiq-postgres) PGUSER(assessiq) PGDB(assessiq)
#   FILES_PATH  STATUS_FILE STATUS_FILE_FILES  BACKUP_TMP(/var/tmp)  MIN_FREE_FACTOR(3)
#   ALERT_ENV_FILE(/srv/assessiq/.env, reads SMTP_URL only) ALERT_TO ALERT_HOOK
#
# Exit codes: 0 ok, 1 step failed (alert sent), 2 config/usage/preflight error (alert sent if possible).
# The script never prints keys, secrets or row data, and it never reads ASSESSIQ_MASTER_KEY.
set -euo pipefail
umask 077

DRY=0; MODE=db
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

: "${BACKUP_ENV_FILE:=/etc/assessiq/backup.env}"
STARTED=$(date +%s)
WORK=""
ALERTED=0
CONFIG_LOADED=0
LAST_NAME="-"; LAST_SIZE="-"; LAST_SHA="-"

say() { printf '%s\n' "$*"; }
show() { printf '[dry-run] would run: %s\n' "$*"; }

# ---------- alert + status + exit handling ----------
alert() { # alert <message>  (existing email path: curl + SMTP_URL, same as tools/ops/assessiq-backup.sh)
  [ "$ALERTED" = 1 ] && return 0
  ALERTED=1
  local msg="$1" smtp to="${ALERT_TO:-connect@assessiq.in}"
  if [ -n "${ALERT_HOOK:-}" ]; then "$ALERT_HOOK" "$msg" || true; return 0; fi
  smtp=$(grep -E '^SMTP_URL=' "${ALERT_ENV_FILE:-/srv/assessiq/.env}" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  [ -n "$smtp" ] || { say "WARN no SMTP_URL, alert not emailed: $msg" >&2; return 0; }
  printf 'From: AssessIQ Backup <%s>\r\nTo: %s\r\nSubject: [AssessIQ] off-site backup FAILED on %s\r\n\r\n%s\r\nSee %s on the VPS.\r\n' \
    "$to" "$to" "$(hostname)" "$msg" "${STATUS_FILE:-/var/log/assessiq/backup-daily.status}" |
    curl -sS --max-time 30 --url "$smtp" --ssl-reqd --mail-from "$to" --mail-rcpt "$to" -T - >/dev/null 2>&1 || true
}

write_status() { # write_status OK|FAIL <reason>
  local sf="${STATUS_FILE:-/var/log/assessiq/backup-daily.status}"
  [ "$MODE" = files ] && sf="${STATUS_FILE_FILES:-/var/log/assessiq/backup-daily-files.status}"
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 mode=$MODE name=$LAST_NAME size=$LAST_SIZE sha256=${LAST_SHA:0:12} secs=$(($(date +%s) - STARTED))"
  [ -z "${2:-}" ] || line="$line reason=$(printf '%s' "$2" | tr -d '\r\n' | cut -c1-200)"
  { mkdir -p "$(dirname "$sf")" && printf '%s\n' "$line" > "$sf.tmp" && mv "$sf.tmp" "$sf"; } 2>/dev/null ||
    say "WARN cannot write status file $sf" >&2
  say "status: $line"
}

die() { # die <exit-code> <message>
  local rc="$1"; shift
  say "FAIL: $*" >&2
  write_status FAIL "$*"
  alert "Off-site backup ($MODE) failed: $*"
  exit "$rc"
}

on_exit() {
  local rc=$?
  trap - EXIT
  [ -z "$WORK" ] || rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$ALERTED" = 0 ] && [ "$DRY" = 0 ] && [ "$CONFIG_LOADED" = 1 ]; then
    write_status FAIL "unexpected error rc=$rc"
    alert "Off-site backup ($MODE) failed with an unexpected error (rc=$rc)."
  fi
  exit "$rc"
}

# ---------- storage layer: r2 (rclone) or local:<dir> (tests) ----------
# Every function takes a path RELATIVE to the prefix, e.g. daily/assessiq-<ts>.dump.age
rc_run() { # rclone with env-only config: no config file, keys never in argv
  RCLONE_CONFIG_AIQR2_TYPE=s3 RCLONE_CONFIG_AIQR2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_AIQR2_ENDPOINT="$R2_ENDPOINT" RCLONE_CONFIG_AIQR2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  RCLONE_CONFIG_AIQR2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" RCLONE_CONFIG_AIQR2_ACL=private \
  RCLONE_CONFIG_AIQR2_NO_CHECK_BUCKET=true RCLONE_CONFIG_AIQR2_ENV_AUTH=false \
    rclone "$@"
}
rpath() { printf 'AIQR2:%s/%s/%s' "$R2_BUCKET" "$R2_PREFIX" "$1"; }
lpath() { printf '%s/%s/%s' "${BACKUP_TARGET#local:}" "$R2_PREFIX" "$1"; }

tgt_put() { # tgt_put <local file> <rel path>
  case "$BACKUP_TARGET" in
    local:*) mkdir -p "$(dirname "$(lpath "$2")")"; cp "$1" "$(lpath "$2")" ;;
    *) rc_run copyto "$1" "$(rpath "$2")" ;;
  esac
}
tgt_cat() { # tgt_cat <rel path>  (stream to stdout)
  case "$BACKUP_TARGET" in
    local:*) cat "$(lpath "$1")" ;;
    *) rc_run cat "$(rpath "$1")" ;;
  esac
}
tgt_ls() { # tgt_ls <rel dir>  -> lines "size name"; empty/missing dir prints nothing
  case "$BACKUP_TARGET" in
    local:*)
      local d f; d="$(lpath "$1")"
      [ -d "$d" ] || return 0
      for f in "$d"/*; do [ -f "$f" ] && printf '%s %s\n' "$(stat -c %s "$f")" "$(basename "$f")"; done
      return 0 ;;
    *) rc_run lsf --files-only --format sp --separator ' ' "$(rpath "$1")" ;;
  esac
}
tgt_rm() { # tgt_rm <rel path>
  case "$BACKUP_TARGET" in
    local:*) rm -f "$(lpath "$1")" ;;
    *) rc_run deletefile "$(rpath "$1")" ;;
  esac
}

# upload_verify <local file> <rel dir> <name> <size> <sha>
# Verify = remote size equals local size AND sha256 of the re-downloaded object equals the local sha.
# ponytail: R2 egress is free, so a full re-download hash is sound; ETag is not (multipart ETag is not an MD5).
upload_verify() {
  local file="$1" dir="$2" name="$3" size="$4" sha="$5" rsize rsha side
  printf '%s  %s\n' "$sha" "$name" > "$WORK/$name.sha256"
  tgt_put "$file" "$dir/$name" || die 1 "upload failed: $dir/$name"
  tgt_put "$WORK/$name.sha256" "$dir/$name.sha256" || die 1 "sidecar upload failed: $dir/$name.sha256"
  if [ -n "${TEST_AFTER_UPLOAD:-}" ] && [ "${BACKUP_TARGET#local:}" != "$BACKUP_TARGET" ]; then
    "$TEST_AFTER_UPLOAD" "$(lpath "$dir/$name")" # tests only: corrupt the uploaded object
  fi
  rsize=$(tgt_ls "$dir" | awk -v n="$name" '$2==n{print $1}') || die 1 "verify: cannot list $dir"
  [ "$rsize" = "$size" ] || die 1 "verify FAILED: size local=$size remote=${rsize:-missing} ($dir/$name)"
  rsha=$(tgt_cat "$dir/$name" | sha256sum | cut -d' ' -f1) || die 1 "verify: cannot re-download $dir/$name"
  [ "$rsha" = "$sha" ] || die 1 "verify FAILED: sha256 mismatch ($dir/$name)"
  side=$(tgt_cat "$dir/$name.sha256") || die 1 "verify: cannot read sidecar"
  [ "$side" = "$sha  $name" ] || die 1 "verify FAILED: sidecar mismatch ($dir/$name.sha256)"
  say "verified $dir/$name size=$size sha256=${sha:0:12}"
}

# prune <rel dir> <name regex> <keep> <must-be-listed name>
# Deletes only exact-pattern objects (and their .sha256) under <rel dir>. Never wipes on a bad listing.
prune() {
  local dir="$1" re="$2" keep="$3" must="$4" listing names n i f
  listing=$(tgt_ls "$dir") || die 1 "retention refused: listing failed for $dir"
  names=$(printf '%s\n' "$listing" | awk 'NF==2{print $2}' | grep -E "$re" | sort || true)
  n=$(printf '%s' "$names" | grep -c . || true)
  [ "$n" -ge 1 ] || die 1 "retention refused: empty listing for $dir (expected at least the new object)"
  printf '%s\n' "$names" | grep -qxF "$must" || die 1 "retention refused: new object $must missing from listing of $dir"
  if [ "$n" -le "$keep" ]; then say "retention $dir: $n kept (limit $keep), nothing to delete"; return 0; fi
  i=0
  while IFS= read -r f; do
    i=$((i + 1)); [ "$i" -le $((n - keep)) ] || break
    tgt_rm "$dir/$f" || die 1 "retention: delete failed $dir/$f"
    tgt_rm "$dir/$f.sha256" || true
    say "retention $dir: deleted $f"
  done <<<"$names"
}

# ---------- config + preflight ----------
load_config() {
  if [ -f "$BACKUP_ENV_FILE" ]; then
    local mode owner
    mode=$(stat -c %a "$BACKUP_ENV_FILE"); owner=$(stat -c %u "$BACKUP_ENV_FILE")
    if [ "$mode" != 600 ] || [ "$owner" != 0 ]; then
      say "REFUSED: $BACKUP_ENV_FILE must be mode 600 and owned by root (mode=$mode uid=$owner)" >&2; exit 2
    fi
    set -a
    # shellcheck disable=SC1090
    . "$BACKUP_ENV_FILE"
    set +a
  fi
  : "${BACKUP_TARGET:=r2}" "${R2_PREFIX:=assessiq}" "${KEEP_DAILY:=7}" "${KEEP_WEEKLY:=4}"
  : "${PG_CONTAINER:=assessiq-postgres}" "${PGUSER:=assessiq}" "${PGDB:=assessiq}"
  : "${BACKUP_TMP:=/var/tmp}" "${MIN_FREE_FACTOR:=3}"
  : "${STATUS_FILE:=/var/log/assessiq/backup-daily.status}"
  CONFIG_LOADED=1
  case "$PG_CONTAINER" in assessiq-*) ;; *) die 2 "refusing container name without assessiq- prefix: $PG_CONTAINER" ;; esac
  [[ "$KEEP_DAILY" =~ ^[0-9]+$ && "$KEEP_DAILY" -ge 1 && "$KEEP_WEEKLY" =~ ^[0-9]+$ && "$KEEP_WEEKLY" -ge 1 ]] ||
    die 2 "KEEP_DAILY and KEEP_WEEKLY must be integers >= 1"
  case "$BACKUP_TARGET" in
    r2) for v in R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
          [ -n "${!v:-}" ] || die 2 "missing config: $v"; done ;;
    local:*) [ "${BACKUP_ALLOW_LOCAL:-0}" = 1 ] || die 2 "local: target is for tests only (set BACKUP_ALLOW_LOCAL=1)" ;;
    *) die 2 "BACKUP_TARGET must be r2 or local:<dir>" ;;
  esac
  [ -n "${AGE_RECIPIENT:-}" ] || [ -n "${AGE_RECIPIENT_FILE:-}" ] || die 2 "set AGE_RECIPIENT or AGE_RECIPIENT_FILE (public key)"
  [[ "${AGE_RECIPIENT:-}" != AGE-SECRET-KEY-* ]] || die 2 "AGE_RECIPIENT is a PRIVATE key. Refused."
  if [ -n "${AGE_RECIPIENT_FILE:-}" ] && grep -q 'AGE-SECRET-KEY-' "$AGE_RECIPIENT_FILE" 2>/dev/null; then
    die 2 "AGE_RECIPIENT_FILE holds a PRIVATE key. Refused."
  fi
}

preflight() {
  local t health dbsize need avail
  for t in docker "${AGE_BIN:-age}" sha256sum tar; do
    command -v "$t" >/dev/null 2>&1 || die 2 "required tool missing: $t"
  done
  case "$BACKUP_TARGET" in r2) command -v rclone >/dev/null 2>&1 || die 2 "required tool missing: rclone" ;; esac
  health=$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || true)
  [ "$health" = healthy ] || die 2 "$PG_CONTAINER is not healthy (status: ${health:-missing})"
  mkdir -p "$BACKUP_TMP"
  WORK=$(mktemp -d "$BACKUP_TMP/assessiq-offsite.XXXXXX"); chmod 700 "$WORK"
  dbsize=$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT pg_database_size(current_database())")
  need=$((dbsize * MIN_FREE_FACTOR))
  avail=$(df -Pk "$WORK" | awk 'NR==2{print $4*1024}')
  [ "$avail" -ge "$need" ] || die 2 "low disk on $BACKUP_TMP: avail=$avail need=$need"
  say "preflight OK db_bytes=$dbsize free_bytes=$avail"
}

age_encrypt() { # age_encrypt <in> <out>  (stdin/stdout: no path quirks)
  if [ -n "${AGE_RECIPIENT:-}" ]; then "${AGE_BIN:-age}" -r "$AGE_RECIPIENT" < "$1" > "$2"
  else "${AGE_BIN:-age}" -R "$AGE_RECIPIENT_FILE" < "$1" > "$2"; fi
  [ "$(head -c 21 "$2")" = "age-encryption.org/v1" ] || return 1
}

finish_object() { # finish_object <plain file> <rel dir base: db|files> <name> <regex>
  local plain="$1" kind="$2" name="$3" re="$4" enc size sha
  enc="$WORK/$name"
  age_encrypt "$plain" "$enc" || die 1 "encryption failed"
  rm -f "$plain"
  size=$(stat -c %s "$enc"); sha=$(sha256sum "$enc" | cut -d' ' -f1)
  LAST_NAME="$name"; LAST_SIZE="$size"; LAST_SHA="$sha"
  upload_verify "$enc" "$kind/daily" "$name" "$size" "$sha"
  prune "$kind/daily" "$re" "$KEEP_DAILY" "$name"
  if [ "$(date -u +%u)" = 7 ] || [ "${FORCE_WEEKLY:-0}" = 1 ]; then
    upload_verify "$enc" "$kind/weekly" "$name" "$size" "$sha"
    prune "$kind/weekly" "$re" "$KEEP_WEEKLY" "$name"
  fi
}

# ---------- dry run ----------
dry_run() {
  local ts name kind; ts=$(date -u +%Y%m%dT%H%M%SZ)
  local pg="${PG_CONTAINER:-assessiq-postgres}" u="${PGUSER:-assessiq}" d="${PGDB:-assessiq}"
  local tmp="${BACKUP_TMP:-/var/tmp}" kd="${KEEP_DAILY:-7}" kw="${KEEP_WEEKLY:-4}"
  say "== dry run ($MODE): no docker, network or file-write call is made =="
  say "1. config: would read ${BACKUP_ENV_FILE} (must be mode 600, owner root) or the environment; target=${BACKUP_TARGET:-r2}"
  say "2. preflight:"
  show "command -v docker age sha256sum tar rclone"
  show "docker inspect -f '{{.State.Health.Status}}' $pg   # must be: healthy"
  show "mkdir -p $tmp; mktemp -d $tmp/assessiq-offsite.XXXXXX; chmod 700 <dir>"
  show "docker exec $pg psql -U $u -d $d -tAc 'SELECT pg_database_size(current_database())'   # free disk >= ${MIN_FREE_FACTOR:-3} x size"
  if [ "$MODE" = files ]; then
    local fp="${FILES_PATH:-<FILES_PATH not set>}"
    say "3. archive uploaded files (skips with a clear message if the path does not exist):"
    show "tar -C $(dirname "$fp") -cf <dir>/assessiq-files-$ts.tar $(basename "$fp")"
    name="assessiq-files-$ts.tar.age"; kind=files
  else
    say "3. dump (pg_dump -Fc is already compressed, no extra gzip):"
    show "docker exec $pg pg_dump -U $u -d $d -Fc > <dir>/assessiq-$ts.dump"
    show "docker exec -i $pg pg_restore -l < <dir>/assessiq-$ts.dump > /dev/null   # integrity check"
    name="assessiq-$ts.dump.age"; kind=db
  fi
  say "4. encrypt with the PUBLIC recipient only:"
  show "age -r \$AGE_RECIPIENT < <plain file> > <dir>/$name   # or: age -R \$AGE_RECIPIENT_FILE"
  show "rm -f <plain file>; sha256sum <dir>/$name"
  say "5. upload and verify (size + sha256 by re-download; sidecar $name.sha256):"
  show "rclone copyto <dir>/$name AIQR2:\$R2_BUCKET/${R2_PREFIX:-assessiq}/$kind/daily/$name   # keys via RCLONE_CONFIG_AIQR2_* env"
  show "rclone copyto <dir>/$name.sha256 AIQR2:\$R2_BUCKET/${R2_PREFIX:-assessiq}/$kind/daily/$name.sha256"
  show "rclone lsf --files-only --format sp AIQR2:\$R2_BUCKET/${R2_PREFIX:-assessiq}/$kind/daily/   # size check"
  show "rclone cat AIQR2:\$R2_BUCKET/${R2_PREFIX:-assessiq}/$kind/daily/$name | sha256sum   # hash check"
  say "6. retention (daily keep $kd, weekly keep $kw; Sunday copy goes to $kind/weekly/):"
  show "rclone lsf ... $kind/daily/  # only names matching ^assessiq-.*\\.(dump|tar)\\.age\$; refuse if empty; rclone deletefile oldest beyond $kd"
  say "7. status + cleanup:"
  show "write ${STATUS_FILE:-/var/log/assessiq/backup-daily.status}  (time, OK/FAIL, size, sha256 prefix, secs)"
  show "rm -rf <dir>   # EXIT trap"
  say "On any failure: status FAIL, email alert via SMTP_URL from ${ALERT_ENV_FILE:-/srv/assessiq/.env} (curl), exit non-zero."
  say "== dry run done =="
}

main() {
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) DRY=1 ;;
      --files) MODE=files ;;
      --help|-h) usage; exit 0 ;;
      *) say "unknown option: $a (try --help)" >&2; exit 2 ;;
    esac
  done
  if [ "$DRY" = 1 ]; then dry_run; exit 0; fi
  trap on_exit EXIT
  load_config
  preflight
  local ts name re
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  if [ "$MODE" = files ]; then
    if [ -z "${FILES_PATH:-}" ] || [ ! -d "$FILES_PATH" ]; then
      say "SKIP --files: FILES_PATH '${FILES_PATH:-}' is not set or does not exist. Nothing uploaded."
      exit 0
    fi
    name="assessiq-files-$ts.tar.age"; re='^assessiq-files-[0-9]{8}T[0-9]{6}Z\.tar\.age$'
    tar -C "$(dirname "$FILES_PATH")" -cf "$WORK/files.tar" "$(basename "$FILES_PATH")" || die 1 "tar failed"
    finish_object "$WORK/files.tar" files "$name" "$re"
  else
    name="assessiq-$ts.dump.age"; re='^assessiq-[0-9]{8}T[0-9]{6}Z\.dump\.age$'
    docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$WORK/db.dump" || die 1 "pg_dump failed"
    docker exec -i "$PG_CONTAINER" pg_restore -l < "$WORK/db.dump" > /dev/null || die 1 "dump failed pg_restore -l integrity check"
    finish_object "$WORK/db.dump" db "$name" "$re"
  fi
  write_status OK ""
}

# Run only when executed, not when sourced (tests source this file to call prune directly).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
