#!/usr/bin/env bash
# Gemini (Antigravity CLI, `agy`) read-only digest runner.
# Use it for bulk reads, call-site lists, doc digests and log triage instead of a Haiku or Sonnet agent.
# Usage:  bash tools/gemini.sh "<prompt>"                 (prompt as one argument)
#         bash tools/gemini.sh --file prompt.txt           (prompt from a file)
# Env:    GEMINI_MODEL (default gemini-3.8-flash-high), GEMINI_TIMEOUT seconds (default 150)
# A run takes about 1 to 2 minutes: start it in the background (run_in_background) and keep working.
# Safety: agy runs with --dangerously-skip-permissions (headless mode needs it), so this wrapper
# (1) prefixes the prompt with a read-only instruction, (2) closes stdin, (3) compares `git status`
# before and after and exits 3 with a warning when the working tree changed.
# Never put secrets, .env contents or customer data in the prompt.
set -u
cd "$(dirname "$0")/.." || exit 1

MODEL="${GEMINI_MODEL:-gemini-3.8-flash-high}"
TMO="${GEMINI_TIMEOUT:-150}"
PROMPT=""
case "${1:-}" in
  --file) [ -f "${2:-}" ] || { echo "usage: bash tools/gemini.sh --file <prompt.txt>" >&2; exit 64; }; PROMPT="$(cat "$2")" ;;
  "" | -h | --help) echo 'usage: bash tools/gemini.sh "<prompt>"  |  --file <prompt.txt>' >&2; exit 64 ;;
  *) PROMPT="$1" ;;
esac

AGY="$(command -v agy 2>/dev/null || true)"
[ -n "$AGY" ] || AGY="$HOME/.gemini/bin/agy.exe"
[ -x "$AGY" ] || { echo "agy not found (expected on PATH or at $HOME/.gemini/bin/agy.exe)" >&2; exit 127; }

PREFIX="READ-ONLY TASK. Do not create, edit, move or delete any file. Do not run commands that change state (no git commit, no installs, no writes). Answer in plain text with file:line facts and keep it short. "

before="$(git status --porcelain | md5sum | cut -d' ' -f1)"
timeout "$((TMO + 20))" "$AGY" -p "${PREFIX}${PROMPT}" --model "$MODEL" --print-timeout "${TMO}s" --dangerously-skip-permissions </dev/null
rc=$?
after="$(git status --porcelain | md5sum | cut -d' ' -f1)"
if [ "$before" != "$after" ]; then
  echo "WARNING: Gemini changed the working tree. Review with git status and git diff before anything else." >&2
  git status --porcelain >&2
  exit 3
fi
exit "$rc"
