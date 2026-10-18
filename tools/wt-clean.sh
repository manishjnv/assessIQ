#!/usr/bin/env bash
# Remove one session worktree safely (Z-57 / S24).
# Usage: bash tools/wt-clean.sh <name> [--force]
# Refuses on uncommitted changes or commits not on origin/main, unless --force.
# With --force, writes a patch and an untracked-file archive to ~/aiq-worktree-backups-<date>/ first.
# Never uses git worktree remove --force. Run this from the main folder.
set -euo pipefail

usage() { echo "usage: bash tools/wt-clean.sh <name> [--force]" >&2; exit 64; }
[ $# -ge 1 ] || usage
NAME="$1"
shift
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

if ! [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refused: name may use letters, digits, dot, dash and underscore only: $NAME" >&2
  exit 64
fi

MAIN="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
TARGET="$MAIN/.claude/worktrees/$NAME"
REGISTERED="$(git worktree list --porcelain | sed -n 's/^worktree //p')"

if ! grep -Fxq "$TARGET" <<< "$REGISTERED"; then
  echo "refused: $TARGET is not a registered worktree. Nothing removed." >&2
  exit 1
fi

TOP="$(git rev-parse --show-toplevel)"
if [ "$TOP" = "$TARGET" ]; then
  echo "refused: you are inside the worktree. Run this from the main folder: $MAIN" >&2
  exit 1
fi

DIRTY=""
if [ -d "$TARGET" ]; then
  DIRTY="$(git -C "$TARGET" status --porcelain)"
fi
AHEAD="$(git log --oneline "origin/main..$NAME" 2>/dev/null || true)"

if [ -n "$DIRTY" ] || [ -n "$AHEAD" ]; then
  if [ "$FORCE" != 1 ]; then
    echo "refused: the worktree is not clean." >&2
    if [ -n "$DIRTY" ]; then
      echo "Uncommitted changes:" >&2
      echo "$DIRTY" >&2
    fi
    if [ -n "$AHEAD" ]; then
      echo "Commits not on origin/main:" >&2
      echo "$AHEAD" >&2
    fi
    echo "Save or push the work first, or rerun with --force (backup is written first)." >&2
    exit 1
  fi
fi

if [ -d "$TARGET" ] && [ "$FORCE" = 1 ] && { [ -n "$DIRTY" ] || [ -n "$AHEAD" ]; }; then
  BK="$HOME/aiq-worktree-backups-$(date +%Y-%m-%d)"
  mkdir -p "$BK"
  git -C "$TARGET" diff HEAD --binary > "$BK/$NAME.patch"
  echo "Backup patch: $BK/$NAME.patch"
  LIST="$(mktemp)"
  git -C "$TARGET" ls-files --others --exclude-standard -z > "$LIST"
  if [ -s "$LIST" ]; then
    (cd "$TARGET" && tar --null -cf "$BK/$NAME-untracked.tar" -T "$LIST")
    echo "Backup untracked files: $BK/$NAME-untracked.tar"
  fi
  rm -f "$LIST"
fi

if [ -d "$TARGET" ]; then
  WIN="$(cygpath -w "$TARGET")"
  # MSYS_NO_PATHCONV stops Git Bash from turning /s and /q into drive letters.
  MSYS_NO_PATHCONV=1 cmd.exe /d /c rmdir /s /q "$WIN" < /dev/null || true
  if [ -d "$TARGET" ]; then
    # rmdir often stops partway on deep pnpm trees. Retry once, then use PowerShell on this one folder.
    MSYS_NO_PATHCONV=1 cmd.exe /d /c rmdir /s /q "$WIN" < /dev/null || true
  fi
  if [ -d "$TARGET" ]; then
    echo "rmdir left files behind. Using PowerShell for this one folder."
    pwsh -NoProfile -Command "Remove-Item -LiteralPath '$WIN' -Recurse -Force -ErrorAction SilentlyContinue" || true
  fi
  if [ -d "$TARGET" ]; then
    echo "refused to continue: $TARGET is still present (a program may hold a file open). Close it and rerun." >&2
    exit 1
  fi
  echo "Removed folder: $TARGET"
fi

git worktree prune
echo "Pruned worktree records."

if git show-ref --verify --quiet "refs/heads/$NAME"; then
  if git merge-base --is-ancestor "$NAME" origin/main 2>/dev/null; then
    git branch -D "$NAME" >/dev/null
    echo "Deleted local branch $NAME (fully merged into origin/main)."
  else
    echo "Kept local branch $NAME (not merged into origin/main). Its commits are still there."
  fi
fi

REGISTERED="$(git worktree list --porcelain | sed -n 's/^worktree //p')"
echo ""
echo "Folders under .claude/worktrees/ that git does not know (ask the owner before any delete):"
FOUND=0
for d in "$MAIN"/.claude/worktrees/*/; do
  [ -d "$d" ] || continue
  p="${d%/}"
  if ! grep -Fxq "$p" <<< "$REGISTERED"; then
    echo "  $p"
    FOUND=1
  fi
done
[ "$FOUND" = 1 ] || echo "  none"
