#!/usr/bin/env bash
# Run the grading eval with the Messages API runtime (anthropic-api), inside assessiq-api.
# Only this one process gets AI_PIPELINE_MODE=anthropic-api and the keys; the container stays
# on claude-code-vps. The keys go over ssh stdin only: not in argv, not on disk, not printed.
#   5th arg "cal" = a test copy of the live skills with the band calibration reworded (live skills untouched).
# Usage (Git Bash, repo root):  bash tools/run-eval-api.sh [20|5] [id-prefixes] [delay-ms] [budget-tokens] [new|old]
#   5th arg "old" grades with the pre-fence skills from /srv/assessiq-skills-backup-20261023, loaded into a temp
#   HOME inside the container (the live skills are not touched). Default "new" = the live skills.
#   20 = start with the key on .env line 46, 5 = start with line 49. The other key is the fallback:
#   the runtime switches to it when the first key is out of credit (credit, auth or limit error).
#   Default prefixes aiq-log-L1-1-0 = a 9-case smoke, capped at 150000 tokens (the run stops past the cap).
# Optional env from your shell, forwarded to the run: AI_API_MODEL_GRADE_ANCHORS, AI_API_MODEL_GRADE_BAND,
#   AI_API_MODEL_GRADE_ESCALATE (model ids, e.g. claude-haiku-5-5), AI_API_EFFORT (low|medium|high).
# Result: runs/<id>/ plus usage.json (token counts per model). Log: /tmp/eval-api.log in the container.
set -euo pipefail
case "${1:-20}" in 20) L1=46; L2=49 ;; 5) L1=49; L2=46 ;; *) echo "first arg must be 20 or 5"; exit 2 ;; esac
ONLY="${2:-aiq-log-L1-1-0}"
DELAY="${3:-500}"
BUDGET="${4:-150000}"
SK="${5:-new}"
TAG="$(date +%H%M%S)"
HOMEDIR=/home/node
if [ "$SK" = "cal" ]; then
  # Test copy of the live skills with the band calibration reworded (live skills untouched).
  HOMEDIR=/tmp/eval-home-cal
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREP'
rm -rf /tmp/eval-home-cal && mkdir -p /tmp/eval-home-cal/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-cal/.claude/skills/
cat > /tmp/cal.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-cal/.claude/skills/grade-band/SKILL.md";
const t = fs.readFileSync(p, "utf8");
const re = /\*\*Calibration\*\*: bands 3 and 4 should be RARE\.[\s\S]*?"so what\."/;
if (!re.test(t)) { console.error("calibration paragraph not found"); process.exit(1); }
fs.writeFileSync(p, t.replace(re, '**Calibration**: grade against the band table above, not against a quota. Give band 4 when all anchors are present, the causal chain is correct and the escalation or decision path is correct; do not hold back a 4 because it is the top band. Give band 3 for a minor causal gap or an imprecise escalation. Band 2 is the median when the candidate has the facts but not the "so what."'));
console.log("calibration patched");
JS
node /tmp/cal.js
PREP
fi
if [ "$SK" = "old" ]; then
  HOMEDIR=/tmp/eval-home-old
  ssh assessiq-vps 'tar -C /srv/assessiq-skills-backup-20261023 -cf - grade-anchors grade-band grade-escalate' | ssh assessiq-vps "docker exec -i assessiq-api sh -c \"mkdir -p $HOMEDIR/.claude/skills && tar -C $HOMEDIR/.claude/skills -xf -\""
fi
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
${AI_API_MODEL_GRADE_ANCHORS:+export AI_API_MODEL_GRADE_ANCHORS=$AI_API_MODEL_GRADE_ANCHORS}
${AI_API_MODEL_GRADE_BAND:+export AI_API_MODEL_GRADE_BAND=$AI_API_MODEL_GRADE_BAND}
${AI_API_MODEL_GRADE_ESCALATE:+export AI_API_MODEL_GRADE_ESCALATE=$AI_API_MODEL_GRADE_ESCALATE}
${AI_API_EFFORT:+export AI_API_EFFORT=$AI_API_EFFORT}
export HOME=$HOMEDIR   # skills under \$HOME/.claude/skills
cd /app
nohup node_modules/.bin/tsx modules/07-ai-grading/eval/cli.ts run --mode anthropic-api --only "$ONLY" --delay-ms "$DELAY" --budget-tokens "$BUDGET" > /tmp/eval-api-$SK-$TAG.log 2>&1 < /dev/null &
echo "eval started (api mode, only=$ONLY); log: /tmp/eval-api-$SK-$TAG.log inside the container"
EOS
} | ssh assessiq-vps 'docker exec -i assessiq-api sh -s'
unset K K2
