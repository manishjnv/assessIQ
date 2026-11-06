#!/usr/bin/env bash
# PostToolUse on Edit|Write|MultiEdit. Lints ONLY the edited ts/tsx/js file (eslint, cached).
# Exit 2 + stderr = Claude sees the errors and fixes them. Never blocks on tool failure.
# Full typecheck stays in `pnpm verify` (push gate); this is the fast per-file layer.
set -uo pipefail
f=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tool_input.file_path||"")}catch{}})')
[ -z "$f" ] && exit 0
case "$f" in
  *.ts|*.tsx|*.js|*.mjs|*.jsx) ;;
  *) exit 0 ;;
esac
case "$f" in *node_modules*|*graphify-out*|*/dist/*|*/docs/*) exit 0 ;; esac
[ -f "$f" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
out=$(timeout 60 pnpm exec eslint --cache --cache-location node_modules/.cache/eslint "$f" 2>&1)
rc=$?
if [ $rc -ne 0 ] && [ $rc -ne 124 ] && echo "$out" | grep -q -E "error|warning"; then
  echo "eslint found problems in $f:" >&2
  echo "$out" | head -40 >&2
  exit 2
fi
exit 0
