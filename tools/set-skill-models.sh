#!/usr/bin/env bash
# Apply the accepted grading setup to the VPS skills (owner decision 2026-10-23 night; docs/05-ai-pipeline.md, "Eval A/B 2026-10-23"):
#   1. grade-band: reword the calibration paragraph (the old text said bands 3 and 4 are RARE; the 5.5 models then never gave a 4).
#   2. Frontmatter models: grade-anchors haiku-5-5, grade-band sonnet-5-5, grade-escalate opus-5-5, generate-* sonnet-5-5,
#      generate-answer-guidance haiku-5-5.
# Source of truth for grading and generation: /srv/assessiq/prompts/skills. Backs up first, then writes in place
# (truncate-write keeps the inode). Safe to run twice. Prints the sha256 of the three grade skills.
# Rollback: cp -a /srv/assessiq-skills-backup-20261023c/. /srv/assessiq/prompts/skills/
# Usage (Git Bash, repo root):  bash tools/set-skill-models.sh
set -euo pipefail
ssh assessiq-vps '[ -d /srv/assessiq-skills-backup-20261023c ] || cp -a /srv/assessiq/prompts/skills /srv/assessiq-skills-backup-20261023c; echo backup-ok'
ssh assessiq-vps 'python3 -' <<'EOF'
import re, glob
MAP = [
    (r'^model: claude-haiku-4-5(-\d+)?\s*$', 'model: claude-haiku-5-5'),
    (r'^model: claude-sonnet-4-6\s*$', 'model: claude-sonnet-5-5'),
    (r'^model: claude-opus-4-7\s*$', 'model: claude-opus-5-5'),
]
CAL_RE = re.compile(r'\*\*Calibration\*\*: bands 3 and 4 should be RARE\.[\s\S]*?"so what\."')
CAL_NEW = ('**Calibration**: grade against the band table above, not against a quota. Give band 4 when all anchors are present, '
           'the causal chain is correct and the escalation or decision path is correct; do not hold back a 4 because it is the '
           'top band. Give band 3 for a minor causal gap or an imprecise escalation. Band 2 is the median when the candidate has '
           'the facts but not the "so what."')
for p in sorted(glob.glob('/srv/assessiq/prompts/skills/*/SKILL.md')):
    with open(p, 'r+', newline='') as f:
        t = f.read()
        o = t
        for pat, new in MAP:
            t = re.sub(pat, new, t, count=1, flags=re.M)
        if p.endswith('/grade-band/SKILL.md'):
            if CAL_RE.search(t):
                t = CAL_RE.sub(lambda m: CAL_NEW, t, count=1)
            elif CAL_NEW not in t:
                raise SystemExit('grade-band: calibration paragraph not found')
        if t != o:
            f.seek(0)
            f.write(t)
            f.truncate()
            print('updated', p.split('/')[-2])
EOF
ssh assessiq-vps 'cd /srv/assessiq/prompts/skills && grep -n "^model:" */SKILL.md && grep -n "Calibration" grade-band/SKILL.md | cut -c1-120 && sha256sum grade-anchors/SKILL.md grade-band/SKILL.md grade-escalate/SKILL.md'
