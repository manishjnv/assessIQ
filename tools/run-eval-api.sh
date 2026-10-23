#!/usr/bin/env bash
# Run the grading eval with the Messages API runtime (anthropic-api), inside assessiq-api.
# Only this one process gets AI_PIPELINE_MODE=anthropic-api and the key; the container stays
# on claude-code-vps. The key goes over ssh stdin only: not in argv, not on disk, not printed.
# Usage (Git Bash, repo root):  bash tools/run-eval-api.sh [20|5] [id-prefixes] [delay-ms]
#   20 = key on .env line 46, 5 = key on line 49. Default prefixes aiq-log-L1-1-0 = a 9-case smoke.
# Result: runs/<id>/ plus usage.json (token counts per model). Log: /tmp/eval-api.log in the container.
set -euo pipefail
case "${1:-20}" in 20) LINE=46 ;; 5) LINE=49 ;; *) echo "first arg must be 20 or 5"; exit 2 ;; esac
ONLY="${2:-aiq-log-L1-1-0}"
DELAY="${3:-500}"
K=$(sed -n "${LINE}p" .env | sed -E 's/^[^=]*=//' | tr -d '\r"'"'")
[ -n "$K" ] || { echo "no key on line $LINE"; exit 1; }
{
  printf "K='%s'\n" "$K"
  cat <<EOS
export ANTHROPIC_API_KEY="\$K"
unset K
export AI_PIPELINE_MODE=anthropic-api
export HOME=/home/node   # skills under /home/node/.claude/skills
cd /app
nohup node_modules/.bin/tsx modules/07-ai-grading/eval/cli.ts run --mode anthropic-api --only "$ONLY" --delay-ms "$DELAY" > /tmp/eval-api.log 2>&1 < /dev/null &
echo "eval started (api mode, only=$ONLY); log: /tmp/eval-api.log inside the container"
EOS
} | ssh assessiq-vps 'docker exec -i assessiq-api sh -s'
unset K
