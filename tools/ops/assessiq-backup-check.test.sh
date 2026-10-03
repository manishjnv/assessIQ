#!/bin/bash
# Self-test for assessiq-backup-check.sh. Run: bash tools/ops/assessiq-backup-check.test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BACKUP_DIR="$tmp/b" CHECK_LOG="$tmp/log/check.log" MIN_BYTES=100
fail=0
expect() { # name, want_code
  bash "$here/assessiq-backup-check.sh" >/dev/null; got=$?
  if [ "$got" -eq "$2" ]; then echo "PASS $1"; else echo "FAIL $1 (got $got want $2)"; fail=1; fi
}
expect missing-dir 2
mkdir -p "$BACKUP_DIR"; expect missing-file 2
head -c 500 /dev/zero > "$BACKUP_DIR/assessiq-a.dump"; expect ok 0
touch -d "30 hours ago" "$BACKUP_DIR/assessiq-a.dump"; expect stale 1
head -c 10 /dev/zero > "$BACKUP_DIR/assessiq-a.dump"; expect too-small 1
if [ "$(wc -l < "$CHECK_LOG")" -eq 5 ]; then echo "PASS log-lines"; else echo "FAIL log-lines"; fail=1; fi
exit "$fail"
