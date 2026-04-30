#!/usr/bin/env bash
# PreToolUse gate on Bash. Runs the global playbook's Phase 2 deterministic checks
# against the staged diff before letting `git commit` through.
# Exits 0 to allow, exits 2 (with stderr) to block.

set -uo pipefail

INPUT=$(cat)

# Extract the bash command we're about to run.
if command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
else
  CMD=$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

# Only gate `git commit`. Everything else passes.
case "$CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# Skip metadata-only amends (no content change — e.g. the noreply-email amend pattern).
case "$CMD" in
  *"--amend"*"--no-edit"*|*"--no-edit"*"--amend"*) exit 0 ;;
esac

# Pull the staged diff. Empty diff = nothing to gate.
DIFF=$(git diff --cached --no-color 2>/dev/null || true)
if [ -z "$DIFF" ]; then
  exit 0
fi

# Only scrutinize ADDED lines (strip context + the '+++ b/file' header lines).
ADDED=$(printf '%s\n' "$DIFF" | grep -E '^\+' | grep -vE '^\+\+\+' || true)

errors=()

# --- Secret signals (regex per global playbook Phase 2) ---
patterns=(
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'sk-[A-Za-z0-9]{20,}'
  'xai-[A-Za-z0-9]{20,}'
  'hf_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'AIza[A-Za-z0-9_-]{30,}'
  'GOCSPX-[A-Za-z0-9_-]{20,}'
  'xox[bp]-[A-Za-z0-9-]{20,}'
)
for pat in "${patterns[@]}"; do
  if printf '%s' "$ADDED" | grep -qE "$pat"; then
    errors+=("secrets-scan: pattern /$pat/ matched")
  fi
done

# --- Hardcoded credential literals (NOT URLs/CSS — only quoted assignments) ---
if printf '%s' "$ADDED" | grep -qE '(password|secret|token|api_key)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"']{8,}["'"'"']'; then
  errors+=("secrets-scan: hardcoded credential literal in staged diff")
fi

# --- TODO / FIXME / XXX markers added in this commit ---
# Rejects un-tagged markers. Allows tagged form like TODO(audit), TODO(phase-1)
# to encode stable cross-phase references that survive merges. Tag must be
# lowercase letters/digits/hyphens. CI workflow uses the same regex.
if printf '%s' "$ADDED" | grep -qP '\b(TODO|FIXME|XXX)\b(?!\([a-z][a-z0-9-]*\))'; then
  errors+=("todo-marker: un-tagged TODO/FIXME/XXX added — resolve, or re-tag as TODO(<lowercase-tag>) for stable cross-phase markers")
fi

# --- AssessIQ-specific: Phase 1 invariants ---
# 1. No ambient `claude` invocations outside the admin-grade handler.
if printf '%s' "$ADDED" | grep -qE "spawn\\s*\\(\\s*[\"']claude[\"']" ; then
  if ! printf '%s' "$DIFF" | grep -qE 'modules/07-ai-grading/(handlers|runtimes)/'; then
    errors+=("phase1-invariant: spawn('claude', ...) added outside modules/07-ai-grading/{handlers,runtimes}/ — see CLAUDE.md § AssessIQ-specific hard rules #1")
  fi
fi
# 2. Agent SDK import outside the gated runtime file.
if printf '%s' "$ADDED" | grep -qE "@anthropic-ai/claude-agent-sdk"; then
  if ! printf '%s' "$DIFF" | grep -qE 'modules/07-ai-grading/runtimes/anthropic-api\.ts'; then
    errors+=("phase1-invariant: @anthropic-ai/claude-agent-sdk imported outside modules/07-ai-grading/runtimes/anthropic-api.ts — see CLAUDE.md § AssessIQ-specific hard rules #2")
  fi
fi
# 3. Domain hardcode.
if printf '%s' "$ADDED" | grep -qE "domain\\s*===?\\s*[\"']soc[\"']"; then
  errors+=("multitenancy-guard: 'domain === \"soc\"' hardcode — domain lives in question packs, not code (CLAUDE.md hard rule #4)")
fi

if [ ${#errors[@]} -gt 0 ]; then
  {
    echo "Pre-commit gate blocked the commit:"
    for e in "${errors[@]}"; do echo "  - $e"; done
    echo
    echo "Fix the issues and re-stage. The gate intentionally does not honor --no-verify."
  } >&2
  exit 2
fi

exit 0
