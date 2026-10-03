#!/bin/bash
# AssessIQ backup dead-man check. Verifies the newest DB dump written by
# assessiq-backup.sh is fresh and non-trivial. Does not install or change anything else.
#
# Exit: 0 OK, 1 STALE (too old or too small), 2 MISSING (no dump / no dir).
# One result line goes to stdout and to $CHECK_LOG (assessiq path only).
# If BACKUP_HEARTBEAT_URL is set, it is pinged (curl -fsS -m 10) ONLY when OK,
# so an external monitor (healthchecks.io etc.) alerts when pings stop.
#
# Env (defaults): BACKUP_DIR=/var/backups/assessiq  BACKUP_GLOB='assessiq-*.dump'
#   MAX_AGE_HOURS=26  MIN_BYTES=10240  CHECK_LOG=/var/log/assessiq/backup-check.log
#
# Install on the VPS (operator, as root; nothing here installs itself):
#   Option A, cron (append one line to root crontab, `crontab -e`):
#     30 6 * * * BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid> /srv/assessiq/tools/ops/assessiq-backup-check.sh
#   Option B, systemd timer (units in infra/systemd/):
#     cp /srv/assessiq/infra/systemd/assessiq-backup-check.service /srv/assessiq/infra/systemd/assessiq-backup-check.timer /etc/systemd/system/
#     systemctl daemon-reload && systemctl enable --now assessiq-backup-check.timer
#   (heartbeat URL for Option B: put BACKUP_HEARTBEAT_URL=... in /etc/default/assessiq-backup-check)
set -u

DIR=${BACKUP_DIR:-/var/backups/assessiq}
GLOB=${BACKUP_GLOB:-assessiq-*.dump}
MAX_H=${MAX_AGE_HOURS:-26}
MIN_B=${MIN_BYTES:-10240}
LOG=${CHECK_LOG:-/var/log/assessiq/backup-check.log}

finish() { # code, status, detail
  local line
  line="$(date -u +%FT%TZ) $2 $3"
  echo "$line"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null && echo "$line" >> "$LOG"
  if [ "$1" -eq 0 ] && [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
    curl -fsS -m 10 "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 || echo "$(date -u +%FT%TZ) WARN heartbeat ping failed" >> "$LOG"
  fi
  exit "$1"
}

newest=""
if [ -d "$DIR" ]; then
  # shellcheck disable=SC2012,SC2086  # names are script-generated; GLOB must expand
  newest=$(ls -1t "$DIR"/$GLOB 2>/dev/null | head -n 1)
fi
if [ -z "$newest" ] || [ ! -f "$newest" ]; then finish 2 MISSING "no $GLOB in $DIR"; fi

size=$(stat -c %s "$newest")
age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
name=$(basename "$newest")

if [ "$age_h" -ge "$MAX_H" ]; then finish 1 STALE "$name age=${age_h}h max=${MAX_H}h"; fi
if [ "$size" -le "$MIN_B" ]; then finish 1 STALE "$name size=${size}B min=${MIN_B}B"; fi
finish 0 OK "$name age=${age_h}h size=${size}B"
