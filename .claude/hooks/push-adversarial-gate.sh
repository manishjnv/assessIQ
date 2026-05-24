#!/usr/bin/env bash
# PreToolUse gate on Bash. Backstop for CLAUDE.md's hard rule:
#   "security/auth/AI-classifier diffs require a codex:rescue (or the sanctioned
#    Sonnet+GLM / opus-takeover ladder) adversarial sign-off BEFORE push."
#
# Fires on `git push`. If any commit about to be pushed touches a load-bearing
# security path (01-auth, 02-tenancy, 07-ai-grading, 14-audit-log, infra,
# Dockerfiles, compose, nginx, .env*) AND none of the pushed commits carries an
# `Adversarial-Review:` trailer, the push is blocked with instructions.
#
# This only catches pushes made THROUGH Claude Code's Bash tool — an operator
# pushing from their own terminal bypasses it. It is a discipline backstop /
# forcing function, not airtight enforcement.
#
# Exits 0 to allow, exits 2 (with stderr) to block.

set -uo pipefail

INPUT=$(cat)

# Extract the bash command we're about to run (jq if present, else sed).
if command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
else
  CMD=$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

# Only gate `git push`. Everything else passes immediately.
case "$CMD" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# Determine the commit range being pushed. Prefer the configured upstream,
# then origin/main, then origin/HEAD. If none resolve (brand-new branch with
# no remote ref), fail OPEN with a warning rather than block a legit first push.
RANGE=""
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  RANGE="@{u}..HEAD"
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
  RANGE="origin/main..HEAD"
elif git rev-parse --verify origin/HEAD >/dev/null 2>&1; then
  RANGE="origin/HEAD..HEAD"
fi

if [ -z "$RANGE" ]; then
  echo "push-adversarial-gate: could not resolve a push range (no upstream/origin ref) — allowing, but verify adversarial sign-off manually for any security paths." >&2
  exit 0
fi

# Files changed across the commits being pushed. Empty = nothing to gate.
CHANGED=$(git diff --name-only "$RANGE" 2>/dev/null || true)
if [ -z "$CHANGED" ]; then
  exit 0
fi

# Load-bearing security paths that require an adversarial sign-off before push
# (matches CLAUDE.md's "requires codex:rescue before push" set).
SEC_RE='^(modules/(01-auth|02-tenancy|07-ai-grading|14-audit-log)/|infra/)|(^|/)Dockerfile|docker-compose|\.env|nginx'

if ! printf '%s\n' "$CHANGED" | grep -qE "$SEC_RE"; then
  exit 0   # no security-adjacent files touched — allow.
fi

# A security path is touched. Require an `Adversarial-Review:` trailer on at
# least one pushed commit. Accepted form (case-insensitive key):
#   Adversarial-Review: <reviewer> <verdict>
# e.g. "Adversarial-Review: codex accept"
#      "Adversarial-Review: sonnet+glm-5.1 revise-addressed"
#      "Adversarial-Review: opus-takeover accept"
MSGS=$(git log "$RANGE" --format='%B' 2>/dev/null || true)
if printf '%s\n' "$MSGS" | grep -qiE '^[[:space:]]*Adversarial-Review:[[:space:]]*[^[:space:]]'; then
  exit 0
fi

{
  echo "Push blocked by push-adversarial-gate:"
  echo
  echo "  Commits in this push touch a load-bearing security path:"
  printf '%s\n' "$CHANGED" | grep -E "$SEC_RE" | sed 's/^/    - /'
  echo
  echo "  CLAUDE.md requires an adversarial sign-off (codex:rescue, or the"
  echo "  sanctioned Sonnet+GLM / opus-takeover ladder) BEFORE pushing these."
  echo
  echo "  Record it by adding a trailer to the relevant commit message, e.g.:"
  echo "      Adversarial-Review: codex accept"
  echo "      Adversarial-Review: sonnet+glm-5.1 revise-addressed"
  echo "      Adversarial-Review: opus-takeover accept"
  echo
  echo "  Amend with the global noreply-email pattern (no extra empty commit),"
  echo "  then re-push. This gate does not honor --no-verify."
} >&2
exit 2
