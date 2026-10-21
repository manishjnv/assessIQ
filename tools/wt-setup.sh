#!/usr/bin/env bash
# Create one git worktree for one session (Z-57 / S24).
# Usage: bash tools/wt-setup.sh <name> [--from origin/main]
# Creates branch <name> and folder .claude/worktrees/<name>, copies .env (contents never printed),
# and runs pnpm install --frozen-lockfile inside the new folder.
set -euo pipefail

usage() { echo "usage: bash tools/wt-setup.sh <name> [--from origin/main]" >&2; exit 64; }
[ $# -ge 1 ] || usage
NAME="$1"
shift
FROM="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) shift; FROM="${1:?--from needs a ref}" ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

if ! [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refused: name may use letters, digits, dot, dash and underscore only: $NAME" >&2
  exit 64
fi

IS_WIN=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; esac

# True for a symlink or a Windows junction. Never follows the link.
is_link() {
  [ -L "$1" ] && return 0
  if [ "$IS_WIN" = 1 ] && [ -d "$1" ]; then
    local w
    w="$(cygpath -w "$1")"
    [ "$(pwsh -NoProfile -Command "(Get-Item -LiteralPath '$w' -Force).LinkType" 2>/dev/null | tr -d '\r')" = "Junction" ]
  else
    return 1
  fi
}

MAIN="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
TARGET="$MAIN/.claude/worktrees/$NAME"

if [ -e "$TARGET" ]; then
  echo "refused: folder already exists: $TARGET" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$NAME"; then
  echo "refused: local branch $NAME already exists." >&2
  exit 1
fi
if git worktree list --porcelain | grep -Fxq "worktree $TARGET"; then
  echo "refused: $TARGET is already a registered worktree." >&2
  exit 1
fi

START=$(date +%s)

echo "Fetching origin..."
git fetch origin --quiet
git worktree add -b "$NAME" "$TARGET" "$FROM"

# docs/ is local only once it is untracked. The worktree gets a link to the main docs/, never a copy.
WT_DOCS="$TARGET/docs"
MAIN_DOCS="$MAIN/docs"
if [ ! -d "$MAIN_DOCS" ]; then
  echo "wt-setup: main clone has no docs/ folder. No junction."
elif [ -n "$(git -C "$TARGET" ls-files -- docs | head -n 1)" ]; then
  echo "wt-setup: docs/ is tracked here, no junction"
elif is_link "$WT_DOCS"; then
  echo "wt-setup: docs/ junction already exists, nothing to do"
elif [ -d "$WT_DOCS" ] && [ -n "$(ls -A "$WT_DOCS")" ]; then
  echo "wt-setup: docs/ exists in the worktree and is not empty. No junction."
else
  if [ -d "$WT_DOCS" ]; then
    rmdir "$WT_DOCS"
  fi
  if [ "$IS_WIN" = 1 ]; then
    MSYS_NO_PATHCONV=1 cmd.exe /d /c mklink /J "$(cygpath -w "$WT_DOCS")" "$(cygpath -w "$MAIN_DOCS")" < /dev/null > /dev/null
  else
    ln -s "$MAIN_DOCS" "$WT_DOCS"
  fi
  echo "wt-setup: docs/ junction -> $MAIN_DOCS (edits inside the worktree change the main docs)"
fi

if [ -f "$MAIN/.env" ]; then
  cp "$MAIN/.env" "$TARGET/.env"
  echo "Copied .env from the main folder (contents not shown)."
else
  echo "No .env in the main folder. Skipped the copy."
fi

echo "Installing dependencies in the worktree (frozen lockfile)..."
if ! (cd "$TARGET" && pnpm install --frozen-lockfile --prefer-offline); then
  echo "pnpm install failed. The worktree is kept at: $TARGET" >&2
  echo "Fix the cause, or remove it with: bash tools/wt-clean.sh $NAME --force" >&2
  exit 1
fi

END=$(date +%s)
echo ""
echo "Worktree ready: $TARGET"
echo "Branch: $NAME (from $FROM)"
echo "Setup time: $((END - START)) seconds"
echo ""
echo "Start a session (manual):"
echo "  1. Open a terminal in: $TARGET"
echo "  2. Run: claude"
echo ""
echo "Finish a unit of work (run each line as its own command):"
echo "  1. git fetch origin && git rebase origin/main"
echo "  2. pnpm verify"
echo "  3. git commit -m \"<message>\"   (only if there are changes; name the paths)"
echo "  4. git push origin HEAD:main     (the push hook needs a fresh verify stamp)"
echo ""
echo "Memory link (manual, one time):"
echo "  1. Run one Claude session in the worktree first."
echo "  2. List %USERPROFILE%\\.claude\\projects\\ and find the folder that is new for this worktree."
echo "  3. In PowerShell or cmd, run:"
echo "     cmd /c mklink /J \"<new folder>\\memory\" \"%USERPROFILE%\\.claude\\projects\\e--code-AssessIQ\\memory\""
