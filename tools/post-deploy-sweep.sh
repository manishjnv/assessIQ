#!/usr/bin/env bash
# Read-only post-deploy sweep. Prints "PASS|FAIL|SKIP|INFO <name> <evidence>"; exit code = number of FAILs.
# Usage: bash tools/post-deploy-sweep.sh [--no-ssh] [--base URL]
set -u
BASE="https://assessiq.in"
SSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-ssh) SSH=0 ;;
    --base) shift; BASE="${1:?--base needs a URL}" ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done
BASE="${BASE%/}"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

res() { # status name evidence
  echo "$1 $2 ${3:-}"
  [ "$1" = FAIL ] && FAILS=$((FAILS + 1))
  return 0
}

# get PATH -> sets CODE, REDIR; body in $TMP/body (no redirect following, browser UA)
get() {
  local out
  out="$(curl -s --max-time 20 -o "$TMP/body" -w '%{http_code} %{num_redirects}' \
    -A "$UA" -H 'Accept: text/html' "$BASE$1" 2>/dev/null)" || true
  CODE="${out%% *}"; REDIR="${out##* }"
  [ -f "$TMP/body" ] || : > "$TMP/body"
}

# (1) readiness
get /api/ready
if [ "$CODE" = 200 ]; then res PASS ready "GET /api/ready 200"; else res FAIL ready "GET /api/ready $CODE"; fi

# (2) pages 200, no redirect; (3) beacon presence/absence
for p in / /try /admin/login /candidate/login /take; do
  get "$p"
  if [ "$CODE" = 200 ] && [ "$REDIR" = 0 ]; then res PASS "page$p" "200 redirects=0"; else res FAIL "page$p" "code=$CODE redirects=$REDIR"; fi
done
for p in / /try /admin/login /take /candidate/login /candidate /embed; do
  get "$p"
  if [ "$p" = /embed ] && [ "$CODE" != 200 ]; then res SKIP "beacon$p" "code=$CODE"; continue; fi
  n="$(grep -c cloudflareinsights "$TMP/body")"
  case "$p" in
    / | /try) want=present ;;
    *) want=absent ;;
  esac
  if { [ "$want" = present ] && [ "$n" -gt 0 ]; } || { [ "$want" = absent ] && [ "$n" -eq 0 ]; }; then
    res PASS "beacon$p" "$want (lines=$n code=$CODE)"
  else
    res FAIL "beacon$p" "expected $want (lines=$n code=$CODE)"
  fi
done

# (4) unauthenticated API must be 401/403
for p in /api/admin/assessments /api/me/assessments /api/admin/webhooks; do
  c="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -A "$UA" "$BASE$p" 2>/dev/null)"
  case "$c" in 401 | 403) res PASS "noauth$p" "$c" ;; *) res FAIL "noauth$p" "got $c" ;; esac
done

# (5) /try SEO basics
get /try
t="$(grep -ci '<title' "$TMP/body")"; c="$(grep -ci 'rel="canonical"' "$TMP/body")"
if [ "$t" -gt 0 ] && [ "$c" -gt 0 ]; then res PASS try-seo "title+canonical"; else res FAIL try-seo "title=$t canonical=$c"; fi

# (6) vendor-react in served /admin/login HTML
get /admin/login
echo "INFO login-scripts $(grep -o '<script[^>]*src="[^"]*"' "$TMP/body" | grep -o 'src="[^"]*"' | tr '\n' ' ')"
vr="$(grep -o '/[^"]*vendor-react[^"]*\.js' "$TMP/body" | sort -u)"
nvr="$(printf '%s' "$vr" | grep -c .)"
if [ "$nvr" -eq 0 ]; then res SKIP vendor-react "none referenced in HTML"
elif [ "$nvr" -eq 1 ]; then res PASS vendor-react "$vr"
else res FAIL vendor-react "$nvr distinct: $(echo $vr)"; fi

# (7) VPS checks (read-only)
if [ "$SSH" -eq 1 ]; then
  SO="-o BatchMode=yes -o ConnectTimeout=15"
  for svc in assessiq-api assessiq-worker; do
    n="$(ssh $SO assessiq-vps "docker logs --since 5m $svc 2>&1 | grep -c '\"level\":50'" 2>/dev/null)"
    if [ "$n" = 0 ]; then res PASS "errors-$svc" "level50=0 in 5m"; else res FAIL "errors-$svc" "level50=${n:-ssh-failed}"; fi
  done
  ps="$(ssh $SO assessiq-vps "docker ps --format '{{.Names}}|{{.Status}}' | grep '^assessiq-'" 2>/dev/null)"
  total="$(printf '%s\n' "$ps" | grep -c .)"
  bad="$(printf '%s\n' "$ps" | grep -v '|Up' | grep -c .; true)"
  unh="$(printf '%s\n' "$ps" | grep -ci unhealthy)"
  if [ "$total" -eq 6 ] && [ "$bad" -eq 0 ] && [ "$unh" -eq 0 ]; then res PASS containers "6 assessiq-* Up"
  else res FAIL containers "total=$total notUp=$bad unhealthy=$unh: $(printf '%s' "$ps" | tr '\n' ';')"; fi
  vps="$(ssh $SO assessiq-vps 'git -C /srv/assessiq log --format=%h -1' 2>/dev/null)"
  loc="$(git rev-parse --short origin/main 2>/dev/null)"
  echo "INFO commits vps=${vps:-?} origin/main=${loc:-?}"
  if [ -n "$vps" ] && git merge-base --is-ancestor "$vps" origin/main 2>/dev/null; then
    res PASS vps-commit "vps $vps is ancestor-or-equal of origin/main $loc"
  else res FAIL vps-commit "vps=${vps:-?} not an ancestor of origin/main=${loc:-?}"; fi
else
  res SKIP vps "--no-ssh"
fi

exit "$FAILS"
