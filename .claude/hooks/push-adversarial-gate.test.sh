#!/usr/bin/env bash
# Self-check for push-adversarial-gate.sh (N3). Run: bash .claude/hooks/push-adversarial-gate.test.sh
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/push-adversarial-gate.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/w" 2>/dev/null
cd "$T/w" || exit 1
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git push -q origin HEAD:main 2>/dev/null
git branch -q -u origin/main 2>/dev/null
mkdir -p infra && echo x > infra/a && git add infra/a
git -c user.email=t@t -c user.name=t commit -q -m "touch infra"

FAIL=0
check() { # $1 payload, $2 expected exit, $3 name
  printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3 (exit $rc, want $2)"; FAIL=1; fi
}
check '{"tool_input":{"command":"ls"}}' 0 "non-push passes"
check '{"tool_input":{"command":"git push"}}' 2 "plain push blocked"
check '{"tool_input":{"command":"GIT_COMMITTER_EMAIL=\"a@b\" git commit --amend --no-edit && git push"}}' 2 "push after escaped quotes blocked (N3)"
check 'not json but git push' 2 "unparseable payload fails closed"
git -c user.email=t@t -c user.name=t commit -q --amend -m "touch infra

Adversarial-Review: codex accept"
check '{"tool_input":{"command":"git push"}}' 0 "trailer allows push"
exit $FAIL
