#!/usr/bin/env bash
# Run the grading eval with the Messages API runtime (anthropic-api), inside assessiq-api.
# Only this one process gets AI_PIPELINE_MODE=anthropic-api and the keys; the container stays
# on claude-code-vps. The keys go over ssh stdin only: not in argv, not on disk, not printed.
# Usage (Git Bash, repo root):  bash tools/run-eval-api.sh [20|5] [id-prefixes] [delay-ms] [budget-tokens]
#   20 = start with the key on .env line 46, 5 = start with line 49. The other key is the fallback:
#   the runtime switches to it when the first key is out of credit (credit, auth or limit error).
#   Default prefixes aiq-log-L1-1-0 = a 9-case smoke, capped at 150000 tokens (the run stops past the cap).
# Result: runs/<id>/ plus usage.json (token counts per model). Log: /tmp/eval-api.log in the container.
set -euo pipefail
case "${1:-20}" in 20) L1=46; L2=49 ;; 5) L1=49; L2=46 ;; *) echo "first arg must be 20 or 5"; exit 2 ;; esac
ONLY="${2:-aiq-log-L1-1-0}"
DELAY="${3:-500}"
BUDGET="${4:-150000}"
key() { sed -n "${1}p" .env | sed -E 's/^[^=]*=//' | tr -d '\r"'"'"; }
K=$(key "$L1")
K2=$(key "$L2")
[ -n "$K" ] || { echo "no key on line $L1"; exit 1; }
{
  printf "K='%s'\nK2='%s'\n" "$K" "$K2"
  cat <<EOS
export ANTHROPIC_API_KEY="\$K"
if [ -n "\$K2" ]; then export ANTHROPIC_API_KEY_FALLBACK="\$K2"; fi
unset K K2
export AI_PIPELINE_MODE=anthropic-api
export HOME=/home/node   # skills under /home/node/.claude/skills
cd /app
nohup node_modules/.bin/tsx modules/07-ai-grading/eval/cli.ts run --mode anthropic-api --only "$ONLY" --delay-ms "$DELAY" --budget-tokens "$BUDGET" > /tmp/eval-api.log 2>&1 < /dev/null &
echo "eval started (api mode, only=$ONLY); log: /tmp/eval-api.log inside the container"
EOS
} | ssh assessiq-vps 'docker exec -i assessiq-api sh -s'
unset K K2
