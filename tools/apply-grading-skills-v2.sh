#!/usr/bin/env bash
# Apply grading prompt candidate v3 (Z-165 iteration 2) to the LIVE grade-band skill. OWNER RUNS THIS; agents may not write the VPS skills.
# Change: band 4 and band 3 table rows rewritten as a completeness check, plus the calibration paragraph with the boundary rule
# (quote the missing or wrong part, else give the next band up). Same text the sealed test judged (tools/run-eval-api.sh ... v3).
# Evidence: sealed test 81/93 = 87.1% against 71/93 for the live skill, McNemar p = 0.013 (docs/05-ai-pipeline.md, Z-165 iteration 2).
# Backs up first, writes in place (truncate-write keeps the inode), safe to run twice, prints the new sha256 of the three grade skills.
# Rollback: ssh assessiq-vps 'cp -a /srv/assessiq-skills-backup-20261024/. /srv/assessiq/prompts/skills/'
# Do not run while an eval or a grading is running (the sha changes mid-run).
# Usage (Git Bash, repo root):  bash tools/apply-grading-skills-v2.sh
set -euo pipefail
ssh assessiq-vps '[ -d /srv/assessiq-skills-backup-20261024 ] || cp -a /srv/assessiq/prompts/skills /srv/assessiq-skills-backup-20261024; echo backup-ok'
ssh assessiq-vps 'python3 -' <<'PY'
import re
p = '/srv/assessiq/prompts/skills/grade-band/SKILL.md'
ROWS = re.compile(r'\| 4 \| All anchors present[^\n]*\n\| 3 \|[^\n]*\n')
CAL = re.compile(r'\*\*Calibration\*\*: grade against the band table above[\s\S]*?"so what\."')
ROWS_NEW = ('| 4 | The answer correctly covers every anchor and every part the question asks for, and its decision or escalation path is sound. '
            'Brevity, order and wording do not lower it: a complete, correct answer is a 4. |\n'
            '| 3 | Correct, but one or two parts the question asks for are missing, thin or imprecise. You can name them. |\n')
CAL_NEW = ('**Calibration**: grade against the band table above, not against a quota. If `rubric.reasoning_bands` is present it defines what '
           'each band means for this question; do not ask for an element the question does not ask for. Method: (1) list the parts the '
           'question asks for; (2) check each one against the answer; (3) if every part is covered correctly, give band 4, even when the '
           'answer is short or plain; (4) otherwise quote in `ai_justification` each part that is missing or wrong. If you cannot quote one '
           'concrete missing or wrong part, give the next band up. A style point or a vague "could be more precise" is not a gap. Band 2 is '
           'the median when the candidate has the facts but not the "so what."')
with open(p, 'r+', newline='') as f:
    t = f.read()
    if CAL_NEW in t and ROWS_NEW in t:
        print('already applied'); raise SystemExit(0)
    if not ROWS.search(t) or not CAL.search(t):
        raise SystemExit('grade-band: band rows or calibration paragraph not found, nothing changed')
    t = ROWS.sub(lambda m: ROWS_NEW, t, count=1)
    t = CAL.sub(lambda m: CAL_NEW, t, count=1)
    f.seek(0); f.write(t); f.truncate()
    print('updated grade-band')
PY
ssh assessiq-vps 'cd /srv/assessiq/prompts/skills && sha256sum grade-anchors/SKILL.md grade-band/SKILL.md grade-escalate/SKILL.md'
