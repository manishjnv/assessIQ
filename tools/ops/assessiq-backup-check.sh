#!/bin/bash
# AssessIQ backup dead-man check. Verifies the newest DB dump written by
# assessiq-backup.sh is fresh and non-trivial. Does not install or change anything else.
# Completeness is the writer's job: assessiq-backup.sh runs `pg_restore -l` on the
# .tmp file and renames it to .dump only when that passes.
#
# Exit: 0 OK, 1 STALE (too old, too small, or future mtime), 2 MISSING (no dump / no dir / bad config).
# One result line goes to stdout and to $CHECK_LOG.
# If BACKUP_HEARTBEAT_URL is set, it is pinged (curl -fsS -m 10) ONLY when OK,
# so an external monitor (healthchecks.io etc.) alerts when pings stop. A failed
# ping is logged and still exits 0: the external monitor is the alarm for that case.
#
# Env (defaults): BACKUP_DIR=/var/backups/assessiq  BACKUP_GLOB='assessiq-*.dump'
#   MAX_AGE_HOURS=26  MIN_BYTES=10240  CHECK_LOG=/var/log/assessiq/backup-check.log
# BACKUP_DIR must stay under /var/backups/assessiq and CHECK_LOG under /var/log/assessiq
# (shared VPS: never read or write outside AssessIQ paths). BACKUP_GLOB may not contain '/'.
#
# Install on the VPS (operator, as root; nothing here installs itself):
#   Option A, cron (append one line to root crontab, `crontab -e`):
#     30 6 * * * BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid> /srv/assessiq/tools/ops/assessiq-backup-check.sh
#   Option B, systemd timer (units in infra/systemd/):
#     cp /srv/assessiq/infra/systemd/assessiq-backup-check.service /srv/assessiq/infra/systemd/assessiq-backup-check.timer /etc/systemd/system/
#     systemctl daemon-reload && systemctl enable --now assessiq-backup-check.timer
#   (heartbeat URL for Option B: put BACKUP_HEARTBEAT_URL=... in /etc/default/assessiq-backup-check,
#    owned root:root, mode 0600 — the root unit trusts every value in it)
set -u

DIR_PREFIX=/var/backups/assessiq
LOG_PREFIX=/var/log/assessiq
DIR=${BACKUP_DIR:-$DIR_PREFIX}
GLOB=${BACKUP_GLOB:-assessiq-*.dump}
MAX_H=${MAX_AGE_HOURS:-26}
MIN_B=${MIN_BYTES:-10240}
LOG=${CHECK_LOG:-$LOG_PREFIX/backup-check.log}

LOG_OK=0
finish() { # code, status, detail
  local line
  line="$(date -u +%FT%TZ) $2 $3"
  echo "$line"
  if [ "$LOG_OK" = 1 ]; then mkdir -p "$(dirname "$LOG")" 2>/dev/null && echo "$line" >> "$LOG"; fi
  if [ "$1" -eq 0 ] && [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
    curl -fsS -m 10 "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 || echo "$(date -u +%FT%TZ) WARN heartbeat ping failed" >> "$LOG"
  fi
  exit "$1"
}

under() { # path, prefix: path is the prefix or inside it, with no '..' segment
  case "$1" in *..*) return 1 ;; "$2"|"$2"/*) return 0 ;; *) return 1 ;; esac
}

under "$LOG" "$LOG_PREFIX" && LOG_OK=1
[ "$LOG_OK" = 1 ] || finish 2 MISSING "CHECK_LOG must be under $LOG_PREFIX"
under "$DIR" "$DIR_PREFIX" || finish 2 MISSING "BACKUP_DIR must be under $DIR_PREFIX"
case "$GLOB" in */*|"") finish 2 MISSING "BACKUP_GLOB must be a plain file pattern" ;; esac
case "$MAX_H$MIN_B" in *[!0-9]*) finish 2 MISSING "MAX_AGE_HOURS and MIN_BYTES must be integers" ;; esac

newest=""
if [ -d "$DIR" ]; then
  # -type f skips symlinks (find does not follow them); -name keeps the pattern quoted.
  newest=$(find "$DIR" -maxdepth 1 -type f -name "$GLOB" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
fi
if [ -z "$newest" ]; then finish 2 MISSING "no $GLOB in $DIR"; fi

size=$(stat -c %s "$newest")
age_s=$(( $(date +%s) - $(stat -c %Y "$newest") ))
name=$(basename "$newest")

if [ "$age_s" -lt 0 ]; then finish 1 STALE "$name mtime is in the future"; fi
if [ "$age_s" -ge $(( MAX_H * 3600 )) ]; then finish 1 STALE "$name age=$(( age_s / 3600 ))h max=${MAX_H}h"; fi
if [ "$size" -le "$MIN_B" ]; then finish 1 STALE "$name size=${size}B min=${MIN_B}B"; fi
finish 0 OK "$name age=$(( age_s / 3600 ))h size=${size}B"
