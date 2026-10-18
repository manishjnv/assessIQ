#!/usr/bin/env bash
# Remove stale testcontainers and ryuk containers left by killed DB test runs (Z-60).
# They make local DB suites time out. Matches testcontainers labels and the ryuk image only.
# Never touches other containers, volumes or images. No docker system prune.
# Usage: bash tools/test-clean.sh [--dry-run]
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: bash tools/test-clean.sh [--dry-run]" >&2; exit 64 ;;
esac

ids="$( { docker ps -aq --filter "label=org.testcontainers=true"; docker ps -aq --filter "ancestor=testcontainers/ryuk" ; } 2>/dev/null | sort -u )"
if [ -z "$ids" ]; then echo "test-clean: no testcontainers found"; exit 0; fi

echo "test-clean: testcontainers found:"
# shellcheck disable=SC2086
docker ps -a --format '  {{.ID}} {{.Image}} {{.Names}}' $(printf -- '--filter id=%s ' $ids)
if [ "$DRY" -eq 1 ]; then echo "test-clean: dry-run, nothing removed"; exit 0; fi
# shellcheck disable=SC2086
docker rm -f $ids >/dev/null
echo "test-clean: removed $(echo "$ids" | wc -l | tr -d ' ') container(s)"
