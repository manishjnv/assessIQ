#!/usr/bin/env bash
# Z-69 (TOK-5): text-only Codex review of committed work, with a secret scan and a size cap.
# Usage:  bash tools/codex-review.sh <base-ref> [--dry-run]
#   Reviews `git diff <base-ref>...HEAD` (committed work only). --dry-run prints the prompt without the diff.
# Exit:   0 ok | 2 diff too big (over 3000 lines, split the review) | 3 secret found or working tree changed
#         4 codex failed or timed out (use the Sonnet takeover gate) | 64 usage
# Env:    CODEX_THREAT overrides the threat model line. CODEX_TIMEOUT seconds (default 300).
# Codex cannot run commands here: the prompt goes in on stdin, nothing else. One attempt, no retry.
# The secret scan runs first, also in --dry-run. It prints the pattern name and the diff line number, never the value.
set -u
BASE="${1:-}"
[ -n "$BASE" ] || { echo "usage: bash tools/codex-review.sh <base-ref> [--dry-run]" >&2; exit 64; }
DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
MAX_LINES=3000
cd "$(git rev-parse --show-toplevel)" || exit 1

DIFF="$(git diff "$BASE"...HEAD)" || { echo "git diff failed for base '$BASE'" >&2; exit 64; }
[ -n "$DIFF" ] || { echo "empty diff for $BASE...HEAD: nothing to review"; exit 0; }
LINES="$(printf '%s\n' "$DIFF" | wc -l | tr -d ' ')"
BYTES="$(printf '%s\n' "$DIFF" | wc -c | tr -d ' ')"
if [ "$LINES" -gt "$MAX_LINES" ]; then
  echo "diff has $LINES lines (cap $MAX_LINES): split the review" >&2
  exit 2
fi

# Secret scan on added lines only. Line numbers are positions in the diff text.
ADDED="$(printf '%s\n' "$DIFF" | grep -n '^+' | grep -v '^[0-9]*:+++')"
found=0
scan() { # name, regex
  local hits
  hits="$(printf '%s\n' "$ADDED" | grep -E -- ":\+.*($2)" | cut -d: -f1 | tr '\n' ' ')"
  if [ -n "$hits" ]; then echo "SECRET PATTERN $1 matched at diff line(s): $hits" >&2; found=1; fi
}
scan aws-akia 'AKIA[0-9A-Z]{16}'
scan aws-asia 'ASIA[0-9A-Z]{16}'
scan sk-key 'sk-[A-Za-z0-9]{20,}'
scan xai-key 'xai-[A-Za-z0-9]{20,}'
scan hf-token 'hf_[A-Za-z0-9]{30,}'
scan github-pat 'github_pat_[A-Za-z0-9_]{20,}'
scan github-token 'gh[pousr]_[A-Za-z0-9]{20,}'
scan google-aiza 'AIza[A-Za-z0-9_-]{30,}'
scan google-gocspx 'GOCSPX-[A-Za-z0-9_-]{20,}'
scan slack-token 'xox[bp]-[A-Za-z0-9-]{20,}'
scan hardcoded-literal "(password|secret|token|api_key)[[:space:]]*=[[:space:]]*[\"'][^\"']{8,}[\"']"
[ "$found" -eq 0 ] || exit 3

THREAT="${CODEX_THREAT:-an authenticated user tries to read or change data of another tenant, or to skip a check that decides who sits a test or gets marks}"
read -r -d '' PROMPT <<EOP
You are an adversarial code reviewer. You have no tools. You cannot run commands or read files. Answer in text only, from the diff below.
Threat model: $THREAT.
Hard invariants (do not flag these as bugs):
- AI grading runs only on admin click. There are no ambient AI calls (no cron, worker, webhook or candidate path).
- Every domain table has tenant_id and an RLS policy.
- Scoring uses the 0/25/50/75/100 bands.
- Audit rows are written in the same transaction through auditInTx.
- totpVerified=true for the pre-MFA session is intentional.
Deliverable: Verdict: accept, revise or reject. Then each concern as file:line with one reason. Maximum 300 words. The last line must be exactly \`VERDICT: accept|revise|reject\` with one word chosen.
EOP

if [ "$DRY" -eq 1 ]; then
  printf '%s\n\n[diff omitted]\n\ndiff lines: %s, bytes: %s, secret scan: clean\n' "$PROMPT" "$LINES" "$BYTES"
  exit 0
fi

before="$(git status --porcelain | md5sum | cut -d' ' -f1)"
OUT="$(printf '%s\n\nDIFF:\n%s\n' "$PROMPT" "$DIFF" | timeout "${CODEX_TIMEOUT:-300}" codex exec --skip-git-repo-check - 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "codex unavailable (exit $rc); use the Sonnet takeover gate (docs/ai-playbook/gate-checklist.md)" >&2
  exit 4
fi
printf '%s\n' "$OUT" | grep -v '^[[:space:]]*$' | tail -n 1
after="$(git status --porcelain | md5sum | cut -d' ' -f1)"
if [ "$before" != "$after" ]; then
  echo "WARNING: codex changed the working tree. Check git status." >&2
  exit 3
fi
exit 0
