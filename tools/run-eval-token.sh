#!/usr/bin/env bash
# Run the grading eval inside assessiq-api with a Claude Max login token (CLAUDE_CODE_OAUTH_TOKEN).
# Use it when the container's own Claude login is out of quota.
# The token goes over ssh stdin only: not in argv, not on disk, not printed.
#
# 1. In any terminal logged in with the Max account:  claude setup-token   (prints a token, starts with sk-ant-oat)
# 2. In Git Bash, repo root:  bash tools/run-eval-token.sh [id-prefixes] [delay-ms]
#    default: aiq-log- (the 50 log cases) with a 2000 ms pause between cases.
set -euo pipefail
ONLY="${1:-aiq-log-}"
DELAY="${2:-2000}"
read -rsp "Paste the token (hidden), then Enter: " K
echo
case "$K" in sk-ant-oat*) ;; *) echo "That is not a sk-ant-oat token. Stop."; exit 1 ;; esac
{
  printf "K='%s'\n" "$K"
  cat <<EOS
export CLAUDE_CODE_OAUTH_TOKEN="\$K"
unset K
export HOME=/home/node   # read the skills under /home/node/.claude/skills
cd /app
nohup node_modules/.bin/tsx modules/07-ai-grading/eval/cli.ts run --mode claude-code-vps --only "$ONLY" --delay-ms "$DELAY" > /tmp/eval2.log 2>&1 < /dev/null &
echo "eval started in assessiq-api; log: /tmp/eval2.log inside the container"
EOS
} | ssh assessiq-vps 'docker exec -i assessiq-api sh -s'
unset K
