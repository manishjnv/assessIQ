#!/usr/bin/env bash
# One-command production deploy. Encodes docs/06-deployment.md "Deploy procedure (steady-state)".
# Usage: bash tools/deploy.sh [--dry-run] [--yes] [--services "assessiq-api assessiq-frontend"] [--no-sweep] [--skip-ci-check] [--skip-signed-in]
# Shared VPS: additive only, assessiq-* services only, no prune/rm/stop/apt/systemctl/caddy. Fails closed before the recreate.
set -u -o pipefail
cd "$(dirname "$0")/.." || exit 1

HOST=assessiq-vps
DIR=/srv/assessiq
COMPOSE="docker compose -f infra/docker-compose.yml"
PSQL="docker exec -i assessiq-postgres psql -U assessiq -d assessiq"
ALLOW='0011_seed_help_content.sql 0100_attempts_ai_proposals_cache 0106_generation_attempts_batch_id 0109_seed_platform_aptitude_pack.sql'
DRY=0; YES=0; SWEEP=1; SKIPCI=0; SKIPSI=0; SERVICES="assessiq-api assessiq-frontend"

usage() { echo "usage: bash tools/deploy.sh [--dry-run] [--yes] [--services \"assessiq-api assessiq-frontend\"] [--no-sweep] [--skip-ci-check] [--skip-signed-in]" >&2; exit 64; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --no-sweep) SWEEP=0 ;;
    --skip-ci-check) SKIPCI=1 ;;
    --skip-signed-in) SKIPSI=1 ;;
    --services) shift; [ $# -gt 0 ] || usage; SERVICES="$1" ;;
    *) usage ;;
  esac
  shift
done
[ "$DRY" -eq 1 ] || [ "$YES" -eq 1 ] || usage

# validate service names, add the worker when the api is deployed (worker uses the api image)
SVC=""
for s in $SERVICES; do
  [[ "$s" =~ ^assessiq-[a-z-]+$ ]] || { echo "bad service name: $s" >&2; usage; }
  SVC="$SVC $s"
done
[ -n "$SVC" ] || usage
case " $SVC " in *" assessiq-api "*) case " $SVC " in *" assessiq-worker "*) ;; *) SVC="$SVC assessiq-worker" ;; esac ;; esac
SVC="${SVC# }"

R() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 "$HOST" "$@"; }
step() { STEPN=$1; echo "STEP $1/7 $2"; }
ok() { echo "OK   step $STEPN${1:+ - $1}"; }
fail() { echo "FAIL step $STEPN - $1" >&2; echo "ABORTED before recreate; nothing was restarted by this script" >&2; exit 1; }
[ "$DRY" -eq 1 ] && echo "MODE dry-run (no change on the VPS beyond git fetch)" || echo "MODE real deploy of: $SVC"

# (1) local preflight
step 1 "local preflight"
git diff --quiet HEAD || echo "WARNING: local tracked files have uncommitted changes (not deployed; the VPS pulls origin/main)"
git fetch -q origin main || fail "git fetch failed"
SHA="$(git rev-parse HEAD)"
[ "$SHA" = "$(git rev-parse origin/main)" ] || fail "local HEAD is not origin/main (push or pull first)"
if [ "$SKIPCI" -eq 1 ]; then
  echo "WARNING: --skip-ci-check set, CI status NOT verified"
else
  ci="$(gh run list --workflow CI --commit "$SHA" --json status,conclusion -q '.[0] | if .conclusion == "" then .status else .conclusion end' 2>/dev/null)"
  [ "$ci" = success ] || fail "CI for ${SHA:0:7} is '${ci:-no run found}' (needs success; wait for the run to finish)"
fi
ok "HEAD=${SHA:0:7} pushed$([ "$SKIPCI" -eq 1 ] || echo ", CI success")"

# (1b) signed-in check before a frontend deploy (Z-47)
case " $SVC " in
  *" assessiq-frontend "*)
    STEPN=1b; echo "STEP 1b/7 signed-in check (frontend)"
    if [ "$SKIPSI" -eq 1 ]; then
      echo "WARNING: --skip-signed-in set, the signed-in check did NOT run"
    elif [ "$DRY" -eq 1 ]; then
      echo "dry-run: would run 'pnpm verify:signed-in' (build + local stack + signed-in smoke spec)"
    else
      pnpm verify:signed-in || fail "signed-in check failed (pnpm verify:signed-in)"
    fi
    ok ;;
esac

# (2) VPS preflight
step 2 "VPS preflight"
R "test -d $DIR/.git" || fail "$DIR is not a git clone (or ssh failed)"
dirty="$(R "cd $DIR && git status --porcelain --untracked-files=no")" || fail "git status failed"
[ -z "$dirty" ] || fail "VPS has tracked-file changes: $dirty"
ok

# (3) pull
step 3 "pull"
OLD="$(R "cd $DIR && git rev-parse --short HEAD")" || fail "cannot read VPS HEAD"
if [ "$DRY" -eq 1 ]; then
  R "cd $DIR && git fetch -q origin" || fail "VPS git fetch failed"
  REF=origin/main
else
  R "cd $DIR && git pull -q --ff-only" || fail "git pull --ff-only failed"
  REF=HEAD
fi
NEWFULL="$(R "cd $DIR && git rev-parse $REF")" || fail "cannot read $REF"
[ "$NEWFULL" = "$SHA" ] || fail "VPS $REF (${NEWFULL:0:7}) differs from local HEAD (${SHA:0:7})"
ok "VPS $OLD -> ${SHA:0:7}"

# (4) drift gate
step 4 "drift gate"
PATHS="$(R "cd $DIR && git ls-tree -r --name-only $REF" | grep -E '^modules/[^/]+/migrations/[^/]+\.sql$')" || fail "cannot list repo migrations"
printf '%s\n' "$PATHS" | sed 's#.*/##' | LC_ALL=C sort -u > "${TMPDIR:-/tmp}/deploy-repo.$$" || fail "sort failed"
DBOUT="$(R "$PSQL -tA -c 'SELECT version FROM schema_migrations'")" || fail "cannot read schema_migrations"
printf '%s\n' "$DBOUT" | grep . | LC_ALL=C sort -u > "${TMPDIR:-/tmp}/deploy-db.$$"
trap 'rm -f "${TMPDIR:-/tmp}/deploy-repo.$$" "${TMPDIR:-/tmp}/deploy-db.$$"' EXIT
DBONLY="$(LC_ALL=C comm -13 "${TMPDIR:-/tmp}/deploy-repo.$$" "${TMPDIR:-/tmp}/deploy-db.$$")"
for v in $DBONLY; do
  case " $ALLOW " in *" $v "*) ;; *) fail "DB-only migration not in allowlist: $v (incident, do not deploy)" ;; esac
done
PENDING="$(LC_ALL=C comm -23 "${TMPDIR:-/tmp}/deploy-repo.$$" "${TMPDIR:-/tmp}/deploy-db.$$")"
NP=0; [ -z "$PENDING" ] || NP="$(printf '%s\n' "$PENDING" | wc -l | tr -d ' ')"
ok "repo=$(wc -l < "${TMPDIR:-/tmp}/deploy-repo.$$" | tr -d ' ') db=$(wc -l < "${TMPDIR:-/tmp}/deploy-db.$$" | tr -d ' ') pending=$NP"
[ "$NP" -eq 0 ] || printf 'pending:\n%s\n' "$PENDING"

# (5) migrations
step 5 "migrations"
for b in $PENDING; do
  [[ "$b" =~ ^[0-9a-z_.]+\.sql$ ]] || fail "unsafe migration file name: $b"
  p="$(printf '%s\n' "$PATHS" | grep "/$b\$" | head -1)"
  [[ "$p" =~ ^modules/[0-9a-z-]+/migrations/[0-9a-z_.]+\.sql$ ]] || fail "unsafe migration path: $p"
  if [ "$DRY" -eq 1 ]; then echo "would apply $p"; continue; fi
  echo "applying $p"
  R bash -s -- "$p" "$b" <<'REMOTE' || fail "migration $b failed (stopped; later files not applied)"
set -eu
cd /srv/assessiq
P="docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1"
$P < "$1"
sum="$(sha256sum "$1" | cut -d' ' -f1)"
$P <<SQL
INSERT INTO schema_migrations(version, checksum) VALUES ('$2', '$sum');
SQL
REMOTE
done
HELPQ="$PSQL -tA -c 'SELECT count(*) FROM help_content'"
before="$(R "$HELPQ")" || fail "cannot count help_content"
if [ "$DRY" -eq 1 ]; then
  ok "dry-run: $NP migration(s) would apply; help_content rows now $before, seed would be re-applied"
else
  R "cd $DIR && $PSQL -v ON_ERROR_STOP=1 < modules/16-help-system/seeds/help_content.sql >/dev/null" || fail "help seed failed"
  after="$(R "$HELPQ")" || fail "cannot count help_content"
  ok "$NP migration(s) applied; help_content $before -> $after"
fi

# (6) build
step 6 "build"
if [ "$DRY" -eq 1 ]; then
  ok "dry-run: would build $SVC"
else
  out="$(R "cd $DIR && $COMPOSE build $SVC > /tmp/deploy-build.log 2>&1; echo BUILD_EXIT=\$?")" || fail "ssh failed during build"
  if [ "$out" != "BUILD_EXIT=0" ]; then
    R "tail -n 3 /tmp/deploy-build.log" >&2
    fail "$out"
  fi
  ok "BUILD_EXIT=0"
fi

# (7) recreate, health wait, sweep
step 7 "recreate"
RC=0; SWEEPRES="skipped"
if [ "$DRY" -eq 1 ]; then
  ok "dry-run: would run 'up -d --no-deps --force-recreate $SVC', wait for healthy, then run the sweep"
  RECREATED="none (dry-run)"
else
  R "cd $DIR && $COMPOSE up -d --no-deps --force-recreate $SVC" || fail "recreate failed"
  RECREATED="$SVC"
  for s in $SVC; do
    st=""; i=0
    while [ "$i" -lt 18 ]; do
      st="$(R "docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $s" 2>/dev/null)"
      case "$st" in healthy | running) break ;; esac
      i=$((i + 1)); sleep 5
    done
    case "$st" in
      healthy) echo "  $s healthy" ;;
      running) echo "  $s running (no healthcheck defined)" ;;
      *) R "docker logs --tail 30 $s 2>&1" >&2; echo "FAIL step 7 - $s is '${st:-unknown}' after 90 s" >&2; exit 1 ;;
    esac
  done
  ok
  if [ "$SWEEP" -eq 1 ]; then
    bash tools/post-deploy-sweep.sh; RC=$?
    SWEEPRES="$RC fail(s)"
  fi
fi
echo "SUMMARY sha=${SHA:0:7} migrations_applied=$([ "$DRY" -eq 1 ] && echo "0 (dry-run, $NP pending)" || echo "$NP") services_recreated=$RECREATED sweep=$SWEEPRES"
exit "$RC"
