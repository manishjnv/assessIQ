#!/usr/bin/env bash
# AssessIQ — one-machine e2e stack: throwaway Postgres 16 + Redis 7 (docker), every
# migration, the API (ENABLE_E2E_TEST_MINTER=true, local process only) and the web dev server.
#   bash apps/web/e2e/local-stack.sh          # up, prints URLs
#   bash apps/web/e2e/local-stack.sh --down   # removes ONLY assessiq-e2e-postgres / assessiq-e2e-redis + our processes
# Then: PLAYWRIGHT_BASE_URL=http://localhost:5173 pnpm --filter @assessiq/web exec playwright test
# NEVER point this at a real deployment. ENABLE_E2E_TEST_MINTER must stay off in production.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PG=assessiq-e2e-postgres; RD=assessiq-e2e-redis
RUN="${TMPDIR:-/tmp}/assessiq-e2e"; mkdir -p "$RUN"

listen_pid() { # pid listening on port $1 (Windows netstat, else lsof)
  if command -v netstat >/dev/null 2>&1 && netstat -ano >/dev/null 2>&1; then
    netstat -ano | tr -d '\r' | awk -v p=":$1" '$2 ~ p"$" && /LISTENING/ {print $NF; exit}'
  else lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; fi
}
kill_tree() { # $1 = pid file (holds the pid of the process that listens on our port)
  [ -f "$1" ] || return 0
  local pid; pid=$(cat "$1")
  if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
  else kill "$pid" 2>/dev/null || true; fi
  rm -f "$1"
}

if [ "${1:-}" = "--down" ]; then
  kill_tree "$RUN/api.pid"; kill_tree "$RUN/web.pid"; kill_tree "$RUN/worker.pid"
  docker rm -f "$PG" "$RD" >/dev/null 2>&1 || true
  echo "e2e stack removed"; exit 0
fi

for port in 3000 5173; do
  [ -z "$(listen_pid $port)" ] || { echo "port $port is busy; stop the process on it (or run --down) first" >&2; exit 1; }
done
# (a) containers on free host ports (docker picks them)
for n in "$PG" "$RD"; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$n"; then echo "$n already exists; run --down first" >&2; exit 1; fi
done
docker run -d --name "$PG" -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=assessiq -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
docker run -d --name "$RD" -p 127.0.0.1::6379 redis:7-alpine >/dev/null
PGPORT=$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://')
RDPORT=$(docker port "$RD" 6379/tcp | head -1 | sed 's/.*://')
until docker exec "$PG" pg_isready -U postgres -d assessiq >/dev/null 2>&1; do sleep 1; done
sleep 2 # the entrypoint restarts postgres once after init

# (b) every migration + the e2e seed (shared with the CI e2e job)
PSQL="docker exec -i -e PGOPTIONS=-cclient_min_messages=warning $PG psql -U postgres -d assessiq" bash apps/web/e2e/seed-db.sh

# (c) API (tsx, no watch). Secrets are dummies for a throwaway database.
B64=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))")
(
  export NODE_ENV=test PORT=3000 LOG_LEVEL=warn ENABLE_E2E_TEST_MINTER=true ORIGIN_TRUST_MODE=off
  export DATABASE_URL="postgres://postgres:e2e@127.0.0.1:$PGPORT/assessiq" REDIS_URL="redis://127.0.0.1:$RDPORT"
  export ASSESSIQ_MASTER_KEY="$B64" SESSION_SECRET="$B64" CERT_SIGNING_SECRET=e2e-dummy-cert-secret
  export ASSESSIQ_BASE_URL=http://localhost:5173 SUPER_ADMIN_EMAILS=manishjnvk@gmail.com
  export RATE_LIMIT_IP_ADMIN=100000 RATE_LIMIT_IP_USER=100000 RATE_LIMIT_IP_ANON=100000 RATE_LIMIT_IP_APIKEY=100000
  export RATE_LIMIT_IP_VERIFIED_ADMIN=100000 RATE_LIMIT_USER_VERIFIED_ADMIN=100000 RATE_LIMIT_CREDENTIAL=100000
  export RATE_LIMIT_IP_CANDIDATE_SESSION=100000 RATE_LIMIT_USER_CANDIDATE=100000 RATE_LIMIT_IP_CANDIDATE_ENTRY=100000 RATE_LIMIT_TENANT=100000
  nohup pnpm --filter @assessiq/api start > "$RUN/api.log" 2>&1 &
  # worker: flips published assessments to active (60 s cron) and auto-submits expired attempts (30 s sweep)
  nohup pnpm --filter @assessiq/api worker > "$RUN/worker.log" 2>&1 &
  WP=$!; ps -p "$WP" 2>/dev/null | awk 'NR==2{print ($4 ~ /^[0-9]+$/) ? $4 : $1}' > "$RUN/worker.pid"
)
for i in $(seq 1 90); do curl -fs http://localhost:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://localhost:3000/api/health >/dev/null || { echo "API did not start; see $RUN/api.log" >&2; exit 1; }

listen_pid 3000 > "$RUN/api.pid"

# (d) web dev server, /api proxied to the API (same origin, like production)
(
  export E2E_API_PROXY=http://127.0.0.1:3000
  nohup pnpm --filter @assessiq/web dev > "$RUN/web.log" 2>&1 &
)
for i in $(seq 1 60); do curl -fs http://localhost:5173/ >/dev/null 2>&1 && break; sleep 1; done
listen_pid 5173 > "$RUN/web.pid"
echo "API  http://localhost:3000   web  http://localhost:5173   postgres 127.0.0.1:$PGPORT   redis 127.0.0.1:$RDPORT"
echo "logs $RUN/{api,worker,web}.log   stop: bash apps/web/e2e/local-stack.sh --down"
