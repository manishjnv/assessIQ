#!/usr/bin/env bash
# Z-62 part 2: run `pnpm verify` in the background after each commit, so the push stamp is ready at push time.
# Usage: bash tools/bg-verify.sh --install   (once per clone: adds .git/hooks/post-commit)
#        bash tools/bg-verify.sh             (what the hook runs; log: .claude/verify-bg.log)
# The stamp is bound to the HEAD tree and the diff (tools/verify-stamp.mjs). If HEAD or the working
# tree changes while verify runs, the stamp is deleted so a half-checked state is never stamped.
set -u -o pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
HOOK="$(git rev-parse --git-path hooks/post-commit)"
if [ "${1:-}" = "--install" ]; then
  if [ -e "$HOOK" ] && ! grep -q bg-verify "$HOOK"; then echo "refused: $HOOK exists and is not ours" >&2; exit 1; fi
  printf '#!/bin/sh\n# installed by tools/bg-verify.sh\n(nohup bash tools/bg-verify.sh >/dev/null 2>&1 &)\n' > "$HOOK"
  chmod +x "$HOOK"; echo "installed $HOOK"; exit 0
fi
mkdir -p .claude
LOG=.claude/verify-bg.log
LOCK=.claude/verify-bg.lock
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then echo "$(date -u +%FT%TZ) skipped: a run is active" >> "$LOG"; exit 0; fi
echo $$ > "$LOCK"; trap 'rm -f "$LOCK"' EXIT
state() { { git rev-parse HEAD; git status --porcelain; git diff HEAD; } | sha256sum; }
before="$(state)"
echo "$(date -u +%FT%TZ) start $(git rev-parse --short HEAD)" > "$LOG"
if pnpm verify >> "$LOG" 2>&1; then rc=0; else rc=1; fi
if [ "$rc" -ne 0 ] || [ "$before" != "$(state)" ]; then rm -f .claude/.verify-stamp; echo "$(date -u +%FT%TZ) stamp removed (rc=$rc or state changed)" >> "$LOG"; else echo "$(date -u +%FT%TZ) stamp ok" >> "$LOG"; fi
