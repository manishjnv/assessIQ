#!/usr/bin/env bash
# Set the latest model ids in the frontmatter of the VPS skills (owner rule 2026-10-23: all AI use on the
# latest Haiku, Sonnet or Opus). Source of truth for grading and generation: /srv/assessiq/prompts/skills.
#   claude-haiku-4-5[-date] -> claude-haiku-5-5 ; claude-sonnet-4-6 -> claude-sonnet-5-5 ; claude-opus-4-7 -> claude-opus-5-5
# Makes a backup copy first, then writes in place (truncate-write keeps the inode). Prints what changed.
# Rollback: cp -a /srv/assessiq-skills-backup-20261023b/. /srv/assessiq/prompts/skills/
# Usage (Git Bash, repo root):  bash tools/set-skill-models.sh
set -euo pipefail
ssh assessiq-vps '[ -d /srv/assessiq-skills-backup-20261023b ] || cp -a /srv/assessiq/prompts/skills /srv/assessiq-skills-backup-20261023b; echo backup-ok'
ssh assessiq-vps 'python3 -' <<'EOF'
import re, glob
MAP = [
    (r'^model: claude-haiku-4-5(-\d+)?\s*$', 'model: claude-haiku-5-5'),
    (r'^model: claude-sonnet-4-6\s*$', 'model: claude-sonnet-5-5'),
    (r'^model: claude-opus-4-7\s*$', 'model: claude-opus-5-5'),
]
for p in sorted(glob.glob('/srv/assessiq/prompts/skills/*/SKILL.md')):
    with open(p, 'r+', newline='') as f:
        t = f.read()
        o = t
        for pat, new in MAP:
            t = re.sub(pat, new, t, count=1, flags=re.M)
        if t != o:
            f.seek(0)
            f.write(t)
            f.truncate()
            print('updated', p.split('/')[-2])
EOF
ssh assessiq-vps 'cd /srv/assessiq/prompts/skills && grep -n "^model:" */SKILL.md'
