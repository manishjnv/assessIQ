#!/usr/bin/env bash
# Run the grading eval with the Messages API runtime (anthropic-api), inside assessiq-api.
# Only this one process gets AI_PIPELINE_MODE=anthropic-api and the keys; the container stays
# on claude-code-vps. The keys go over ssh stdin only: not in argv, not on disk, not printed.
#   5th arg "cal" = a test copy of the live skills with the band calibration reworded (live skills untouched).
#   "v3" = v2 boundary rule plus a completeness-check band-4 criterion (Z-165 iteration 2).
#   "cal2" = "cal" plus the grade-anchors hit rule reworded (less strict on terse but clear answers).
# Usage (Git Bash, repo root):  bash tools/run-eval-api.sh [20|5] [id-prefixes] [delay-ms] [budget-usd] [new|old|cal|cal2|v2|v3] [budget-tokens]
#   5th arg "old" grades with the pre-fence skills from /srv/assessiq-skills-backup-20261023, loaded into a temp
#   HOME inside the container (the live skills are not touched). Default "new" = the live skills.
#   20 = start with the key on .env line 46, 5 = start with line 49. The other key is the fallback:
#   the runtime switches to it when the first key is out of credit (credit, auth or limit error).
#   Default prefixes aiq-log-L1-1-0 = a 9-case smoke. 4th arg = the USD cap (Z-164 E9); empty = the harness default:
#   US$10 when the prefixes select every case (the full 151-case run, for example "aiq-"), US$1 for any regular test. The run stops past the cap,
#   keeps the partial results and exits 2 (such a run is never compared or blessed). 6th arg = an optional second cap in tokens.
# Optional env from your shell, forwarded to the run: AI_API_MODEL_GRADE_ANCHORS, AI_API_MODEL_GRADE_BAND,
#   AI_API_MODEL_GRADE_ESCALATE (model ids, e.g. claude-haiku-5-5), AI_API_EFFORT (low|medium|high).
# Result: runs/<id>/ plus usage.json (token counts per model). Log: /tmp/eval-api.log in the container.
set -euo pipefail
case "${1:-20}" in 20) L1=46; L2=49 ;; 5) L1=49; L2=46 ;; *) echo "first arg must be 20 or 5"; exit 2 ;; esac
ONLY="${2:-aiq-log-L1-1-0}"
DELAY="${3:-500}"
USD="${4:-}"
SK="${5:-new}"
TOKENS="${6:-0}"
TAG="$(date +%H%M%S)"
HOMEDIR=/home/node
if [ "$SK" = "cal" ] || [ "$SK" = "cal2" ]; then
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
  if [ "$SK" = "cal2" ]; then
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREP2'
cat > /tmp/cal2.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-cal/.claude/skills/grade-anchors/SKILL.md";
const t = fs.readFileSync(p, "utf8");
const re = /- \*\*Hit\*\* requires[\s\S]*?→ miss\./;
if (!re.test(t)) { console.error("hit rule not found"); process.exit(1); }
fs.writeFileSync(p, t.replace(re, '- **Hit** when the answer states the concept in its own words, even briefly. A short but clear statement of the concept is a hit. Mark a miss when the concept is absent, or appears only as a bare keyword list with no statement about it (for example "lateral, movement, T1021").'));
console.log("anchors hit rule patched");
JS
node /tmp/cal2.js
PREP2
  fi
fi
if [ "$SK" = "v2" ]; then
  # Z-165 prompt candidate v2: a test copy of the LIVE skills with the grade-band calibration replaced by a boundary
  # rule (name the missing element or give the next band up) and one band table. Live skills are not touched.
  HOMEDIR=/tmp/eval-home-v2
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV2'
rm -rf /tmp/eval-home-v2 && mkdir -p /tmp/eval-home-v2/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v2/.claude/skills/
cat > /tmp/v2.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v2/.claude/skills/grade-band/SKILL.md";
const t = fs.readFileSync(p, "utf8");
const re = /\*\*Calibration\*\*: grade against the band table above[\s\S]*?"so what\."/;
if (!re.test(t)) { console.error("calibration paragraph not found"); process.exit(1); }
const v2 = '**Calibration**: grade against the band table above, not against a quota. If `rubric.reasoning_bands` is present it defines what each band means for this question and the table above is guidance; do not ask for an element the question does not ask for. Give band 4 when all anchors are present, the causal chain is correct and the escalation or decision path is correct; do not hold back a 4 because it is the top band. **Boundary rule:** for any band below 4, quote in `ai_justification` the specific element that is missing or wrong (a fact, a step in the causal chain, or an escalation or decision the question asks for). If you cannot name one concrete element that the question or rubric asks for and the answer lacks or gets wrong, give the next band up. A style point, a missing nicety or a vague "could be more precise" is not a gap. Give band 3 only for a named minor causal gap or an imprecise escalation. Band 2 is the median when the candidate has the facts but not the "so what."';
fs.writeFileSync(p, t.replace(re, () => v2));
console.log("v2 calibration patched");
JS
node /tmp/v2.js
PREPV2
fi
if [ "$SK" = "v3" ]; then
  # Z-165 prompt candidate v3 (iteration 2): v2 boundary rule plus a band-4 criterion that is a completeness check,
  # not a conjunction of three separate conditions. Test copy of the LIVE skills; live skills are not touched.
  HOMEDIR=/tmp/eval-home-v3
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV3'
rm -rf /tmp/eval-home-v3 && mkdir -p /tmp/eval-home-v3/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v3/.claude/skills/
cat > /tmp/v3.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v3/.claude/skills/grade-band/SKILL.md";
let t = fs.readFileSync(p, "utf8");
const rows = /\| 4 \| All anchors present[^\n]*\n\| 3 \|[^\n]*\n/;
const cal = /\*\*Calibration\*\*: grade against the band table above[\s\S]*?"so what\."/;
if (!rows.test(t) || !cal.test(t)) { console.error("band rows or calibration not found"); process.exit(1); }
t = t.replace(rows, () => '| 4 | The answer correctly covers every anchor and every part the question asks for, and its decision or escalation path is sound. Brevity, order and wording do not lower it: a complete, correct answer is a 4. |\n| 3 | Correct, but one or two parts the question asks for are missing, thin or imprecise. You can name them. |\n');
t = t.replace(cal, () => '**Calibration**: grade against the band table above, not against a quota. If `rubric.reasoning_bands` is present it defines what each band means for this question; do not ask for an element the question does not ask for. Method: (1) list the parts the question asks for; (2) check each one against the answer; (3) if every part is covered correctly, give band 4, even when the answer is short or plain; (4) otherwise quote in `ai_justification` each part that is missing or wrong. If you cannot quote one concrete missing or wrong part, give the next band up. A style point or a vague "could be more precise" is not a gap. Band 2 is the median when the candidate has the facts but not the "so what."');
fs.writeFileSync(p, t);
console.log("v3 band table and calibration patched");
JS
node /tmp/v3.js
PREPV3
fi
if [ "$SK" = "v4" ]; then
  # Z-165 candidate v4: the LIVE skills (v3) plus one band 0 vs 1 boundary rule. Test copy; live skills are not touched.
  HOMEDIR=/tmp/eval-home-v4
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV4'
rm -rf /tmp/eval-home-v4 && mkdir -p /tmp/eval-home-v4/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v4/.claude/skills/
cat > /tmp/v4.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v4/.claude/skills/grade-band/SKILL.md";
let t = fs.readFileSync(p, "utf8");
const row0 = /\| 0 \| Wrong direction or no answer\. \|/;
if (!row0.test(t)) { console.error("band 0 row not found"); process.exit(1); }
t = t.replace(row0, () => '| 0 | No answer, off-topic, or the direction is wrong (it names nothing relevant, or its main claim is incorrect). An answer that states even one relevant, correct fact about the question is not a 0: give it band 1 or higher. |');
fs.writeFileSync(p, t);
console.log("v4 band 0 row patched");
JS
node /tmp/v4.js
PREPV4
fi
if [ "$SK" = "v5" ]; then
  # Z-165 candidate v5 (S57): the LIVE skills (v3) with band 4 tolerant of small imprecision inside a covered part,
  # band 3 = a whole part missing or wrong, band 1 = any relevant correct element, band 0 = nothing relevant correct
  # (raw paste back included). Written from the blind re-label of the 10 grader errors; judge ONLY on split-v2 (ids v2-).
  HOMEDIR=/tmp/eval-home-v5
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV5'
rm -rf /tmp/eval-home-v5 && mkdir -p /tmp/eval-home-v5/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v5/.claude/skills/
cat > /tmp/v5.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v5/.claude/skills/grade-band/SKILL.md";
let t = fs.readFileSync(p, "utf8");
const r4 = /\| 4 \|[^\n]*\n/, r3 = /\| 3 \|[^\n]*\n/, r1 = /\| 1 \|[^\n]*\n/, r0 = /\| 0 \|[^\n]*\n/;
for (const r of [r4, r3, r1, r0]) if (!r.test(t)) { console.error("band row not found", r); process.exit(1); }
t = t.replace(r4, () => "| 4 | The answer correctly covers every anchor and every part the question asks for, and its decision or escalation path is sound. Brevity, order and wording do not lower it. A small imprecision, a thin detail or a missing example inside a part that is otherwise covered correctly does NOT lower it. |\n");
t = t.replace(r3, () => "| 3 | Correct, but a whole part the question asks for is missing, wrong or only gestured at. You can name that part. |\n");
t = t.replace(r1, () => "| 1 | Some relevant correct content (one correct fact, step or observation), but the rest is thin, wrong or shown without understanding. Any relevant correct element puts the answer at band 1 or higher. |\n");
t = t.replace(r0, () => "| 0 | No answer, off-topic, or nothing relevant is correct (its main claims are wrong). Pasting the question or the raw logs back with no finding of the candidate's own is a 0. |\n");
const k = "(3) if every part is covered correctly, give band 4, even when the answer is short or plain;";
if (!t.includes(k)) { console.error("calibration step not found"); process.exit(1); }
t = t.replace(k, () => "(3) if every part is covered correctly, give band 4, even when the answer is short or plain and even when a detail inside a part is thin or slightly imprecise;");
fs.writeFileSync(p, t);
console.log("v5 patched");
JS
node /tmp/v5.js
PREPV5
fi
if [ "$SK" = "v6" ]; then
  # Z-165 candidate v6 (S57): the LIVE skills (v3) with ONLY the band 4 row and calibration step (3) changed:
  # a small imprecision, thin detail or missing example inside a covered part does not lower band 4. Bands 0-3 untouched.
  HOMEDIR=/tmp/eval-home-v6
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV6'
rm -rf /tmp/eval-home-v6 && mkdir -p /tmp/eval-home-v6/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v6/.claude/skills/
cat > /tmp/v6.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v6/.claude/skills/grade-band/SKILL.md";
let t = fs.readFileSync(p, "utf8");
const r4 = /\| 4 \|[^\n]*\n/;
if (!r4.test(t)) { console.error("band 4 row not found"); process.exit(1); }
t = t.replace(r4, () => "| 4 | The answer correctly covers every anchor and every part the question asks for, and its decision or escalation path is sound. Brevity, order and wording do not lower it. A small imprecision, a thin detail or a missing example inside a part that is otherwise covered correctly does NOT lower it. |\n");
const k = "(3) if every part is covered correctly, give band 4, even when the answer is short or plain;";
if (!t.includes(k)) { console.error("calibration step not found"); process.exit(1); }
t = t.replace(k, () => "(3) if every part is covered correctly, give band 4, even when the answer is short or plain and even when a detail inside a part is thin or slightly imprecise;");
fs.writeFileSync(p, t);
console.log("v6 patched");
JS
node /tmp/v6.js
PREPV6
fi
if [ "$SK" = "v7" ]; then
  # Z-165 candidate v7 (S57): the LIVE skills (v3) with ONLY the band 3 and band 2 rows plus one calibration sentence changed:
  # a missing part alone does not make a 2; band 2 = covers only some parts or lists facts without connecting them.
  # Written from the split-v3 failures (7 band-3 answers graded 2); judge ONLY on split-v4 (ids v4-). Bands 0, 1, 4 untouched.
  HOMEDIR=/tmp/eval-home-v7
  ssh assessiq-vps 'docker exec -i assessiq-api sh -s' <<'PREPV7'
rm -rf /tmp/eval-home-v7 && mkdir -p /tmp/eval-home-v7/.claude/skills
cp -r /home/node/.claude/skills/grade-anchors /home/node/.claude/skills/grade-band /home/node/.claude/skills/grade-escalate /tmp/eval-home-v7/.claude/skills/
cat > /tmp/v7.js <<'JS'
const fs = require("fs");
const p = "/tmp/eval-home-v7/.claude/skills/grade-band/SKILL.md";
let t = fs.readFileSync(p, "utf8");
const r3 = /\| 3 \|[^\n]*\n/, r2 = /\| 2 \|[^\n]*\n/;
if (!r3.test(t) || !r2.test(t)) { console.error("band 2 or 3 row not found"); process.exit(1); }
t = t.replace(r3, () => "| 3 | The main findings or most steps are correct and connected by reasoning, but one or two parts the question asks for are missing, thin or imprecise. You can name them. Missing a part, or an anchor that Stage 1 did not find, does NOT by itself make it a 2. |\n");
t = t.replace(r2, () => "| 2 | Covers only some of the parts, or mostly lists facts or steps without connecting them (little reasoning), so that more than one or two parts are missing or the logic is thin. |\n");
const k = 'A style point or a vague "could be more precise" is not a gap.';
if (!t.includes(k)) { console.error("calibration sentence not found"); process.exit(1); }
t = t.replace(k, () => k + " If the main findings are right and the reasoning connects them, one or two missing parts give band 3, not band 2.");
fs.writeFileSync(p, t);
console.log("v7 patched");
JS
node /tmp/v7.js
PREPV7
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
${EVAL_FORCE_ESCALATE:+export EVAL_FORCE_ESCALATE=$EVAL_FORCE_ESCALATE}
export HOME=$HOMEDIR   # skills under \$HOME/.claude/skills
cd /app
nohup node_modules/.bin/tsx modules/07-ai-grading/eval/cli.ts run --mode anthropic-api --only "$ONLY" --delay-ms "$DELAY" ${USD:+--budget-usd $USD} --budget-tokens "$TOKENS" > /tmp/eval-api-$SK-$TAG.log 2>&1 < /dev/null &
echo "eval started (api mode, only=$ONLY); log: /tmp/eval-api-$SK-$TAG.log inside the container"
EOS
} | ssh assessiq-vps 'docker exec -i assessiq-api sh -s'
unset K K2
