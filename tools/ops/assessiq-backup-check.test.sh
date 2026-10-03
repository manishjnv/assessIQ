#!/bin/bash
# Self-test for assessiq-backup-check.sh. Run: bash tools/ops/assessiq-backup-check.test.sh
# Runs a temp copy whose AssessIQ path prefixes point into a temp dir (no runtime bypass flag).
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
sed -e "s#^DIR_PREFIX=.*#DIR_PREFIX=$tmp/b#" -e "s#^LOG_PREFIX=.*#LOG_PREFIX=$tmp/log#" \
  "$here/assessiq-backup-check.sh" > "$tmp/check.sh"
export BACKUP_DIR="$tmp/b" CHECK_LOG="$tmp/log/check.log" MIN_BYTES=100
fail=0
expect() { # name, want_code
  bash "$tmp/check.sh" >/dev/null; got=$?
  if [ "$got" -eq "$2" ]; then echo "PASS $1"; else echo "FAIL $1 (got $got want $2)"; fail=1; fi
}
expect missing-dir 2
mkdir -p "$BACKUP_DIR"; expect missing-file 2
head -c 500 /dev/zero > "$BACKUP_DIR/assessiq-a.dump"; expect ok 0
touch -d "30 hours ago" "$BACKUP_DIR/assessiq-a.dump"; expect stale 1
touch -d "2 hours" "$BACKUP_DIR/assessiq-a.dump"; expect future-mtime 1
head -c 10 /dev/zero > "$BACKUP_DIR/assessiq-a.dump"; expect too-small 1
if [ "$(wc -l < "$CHECK_LOG")" -eq 6 ]; then echo "PASS log-lines"; else echo "FAIL log-lines"; fail=1; fi
rm -f "$BACKUP_DIR/assessiq-a.dump"
head -c 500 /dev/zero > "$tmp/real.dump"; ln -s "$tmp/real.dump" "$BACKUP_DIR/assessiq-link.dump" 2>/dev/null
# Git Bash on Windows copies instead of linking; run the case only for a real symlink.
if [ -L "$BACKUP_DIR/assessiq-link.dump" ]; then expect symlink-ignored 2; else echo "SKIP symlink-ignored (no real symlinks here)"; fi
rm -f "$BACKUP_DIR/assessiq-link.dump"
BACKUP_DIR=/tmp expect dir-outside-assessiq 2
CHECK_LOG=/tmp/x.log expect log-outside-assessiq 2
BACKUP_GLOB='../*' expect glob-with-slash 2
exit "$fail"
