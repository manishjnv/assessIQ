#!/bin/bash
# /etc/cron.daily/assessiq-backup — AssessIQ daily Postgres logical backup (installed 2026-10-01).
# Offsite copy = Hostinger weekly VPS backup (owner-enabled), which includes /var/backups/assessiq.
# ponytail: failure alert is an email via the app's own Brevo SMTP; a dead cron daemon sends nothing —
# add an external dead-man ping (healthchecks.io) if that ever matters.
set -euo pipefail

DEST=/var/backups/assessiq
LOG=/var/log/assessiq/backup.log
KEEP_DAYS=14
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/assessiq-$TS.dump"

alert() {
  local smtp
  smtp=$(grep -E '^SMTP_URL=' /srv/assessiq/.env | cut -d= -f2- | tr -d '"' || true)
  [ -n "$smtp" ] || return 0
  printf 'From: AssessIQ Backup <connect@assessiq.in>\r\nTo: connect@assessiq.in\r\nSubject: [AssessIQ] DB backup FAILED on %s\r\n\r\n%s\r\nSee %s on the VPS.\r\n' \
    "$(hostname)" "$1" "$LOG" |
    curl -sS --max-time 30 --url "$smtp" --ssl-reqd \
      --mail-from connect@assessiq.in --mail-rcpt connect@assessiq.in -T - >/dev/null 2>&1 || true
}
trap 'rc=$?; echo "$(date -u +%FT%TZ) FAIL rc=$rc line=$LINENO" >> "$LOG"; rm -f "$OUT.tmp"; alert "Backup script failed (exit $rc at line $LINENO)."' ERR

mkdir -p "$DEST"
chmod 700 "$DEST"

docker exec assessiq-postgres pg_dump -U assessiq -d assessiq -Fc > "$OUT.tmp"
# Integrity check: the archive must list cleanly before we keep it.
docker exec -i assessiq-postgres pg_restore -l < "$OUT.tmp" > /dev/null
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"

find "$DEST" -maxdepth 1 -type f -name 'assessiq-*.dump' -mtime +"$KEEP_DAYS" -delete

# AI prompt skills: gitignored since 2026-10-01 (public repo), so this host copy
# is the source of truth — keep a daily tarball alongside the DB dump.
if [ -d /srv/assessiq/prompts/skills ]; then
  tar -czf "$DEST/prompts-skills-$TS.tgz" -C /srv/assessiq/prompts skills
  chmod 600 "$DEST/prompts-skills-$TS.tgz"
  find "$DEST" -maxdepth 1 -type f -name 'prompts-skills-*.tgz' -mtime +"$KEEP_DAYS" -delete
else
  echo "$(date -u +%FT%TZ) WARN prompts/skills missing" >> "$LOG"
  alert "prompts/skills directory is missing on the VPS — AI grading/generation prompts unavailable."
fi

echo "$(date -u +%FT%TZ) OK $(basename "$OUT") $(stat -c %s "$OUT") bytes" >> "$LOG"
