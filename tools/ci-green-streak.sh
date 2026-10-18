#!/usr/bin/env bash
# Z-60: count the current streak of green CODE runs of ci.yml on main since the commit that set
# Playwright retries to 0 (8eb0a949). Docs-only runs are ignored (docs/, *.md, .vale/ only).
# Usage: bash tools/ci-green-streak.sh [since-sha]   Exit 0 always (read-only); 2 when gh fails.
set -u
SINCE_SHA="${1:-8eb0a949}"
cd "$(git rev-parse --show-toplevel)" || exit 2
since_ts=$(git log -1 --format=%ct "$SINCE_SHA" 2>/dev/null) || { echo "unknown commit $SINCE_SHA" >&2; exit 2; }
json=$(gh run list --workflow ci.yml --branch main --limit 40 --json status,conclusion,headSha,createdAt) || exit 2

# One line per completed run, newest first: epoch seconds<TAB>sha<TAB>conclusion
rows=$(printf '%s' "$json" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const x of r) if (x.status === "completed") console.log([Math.floor(Date.parse(x.createdAt) / 1000), x.headSha, x.conclusion].join("\t"));')

is_docs_only() { # all files of the commit under docs/, *.md or .vale/
  local f n=0
  while IFS= read -r f; do
    n=$((n + 1))
    case "$f" in docs/*|.vale/*|*.md) ;; *) return 1 ;; esac
  done < <(git diff-tree --no-commit-id --name-only -r --root "$1")
  [ "$n" -gt 0 ]
}

streak=0; broken=""; ignored=0
while IFS=$'\t' read -r ts sha concl; do
  [ -z "$sha" ] && continue
  [ "$ts" -lt "$since_ts" ] && break          # older than the retries-0 commit
  if is_docs_only "$sha"; then ignored=$((ignored + 1)); continue; fi
  if [ "$concl" = "success" ]; then streak=$((streak + 1)); else broken="${sha:0:8} ($concl)"; break; fi
done <<< "$rows"

echo "streak $streak of 10 (green code runs on main since ${SINCE_SHA}; docs-only runs ignored: $ignored)"
[ -n "$broken" ] && echo "streak ended by red code run $broken"
exit 0
