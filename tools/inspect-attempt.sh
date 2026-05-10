#!/usr/bin/env bash
# tools/inspect-attempt.sh
#
# One-line wrapper: dump the full diagnostic surface of a generation_attempts
# row from the VPS. Surfaces stderr_tail, per-chunk timings, error codes,
# and inserted-question contentKeys — the gap that was invisible in
# score-candidate output.
#
# Usage:
#   bash tools/inspect-attempt.sh <attempt-uuid>
#   bash tools/inspect-attempt.sh 019e0deb-4dcf-70b1-83fe-8c88e20b7b62
#
# Requires: SSH access to assessiq-vps (key in ssh-agent).
set -euo pipefail
ssh assessiq-vps "docker exec -w /app/modules/07-ai-grading assessiq-api \
  pnpm exec tsx /app/modules/07-ai-grading/eval/cli-typed.ts inspect-attempt \
  --attempt-id $1 --show-stderr --show-questions"
