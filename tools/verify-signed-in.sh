#!/usr/bin/env bash
# Z-47: signed-in check before a frontend deploy. Builds apps/web, starts the local e2e stack
# (apps/web/e2e/local-stack.sh), serves THAT build with `vite preview` on :5173, runs the
# signed-in smoke spec, then removes the stack. Exit code 0 only when the spec passes.
# The dev session minter lives only in this local API process; it is never enabled on production.
set -u -o pipefail
cd "$(dirname "$0")/.." || exit 1
export E2E_API_PORT="${E2E_API_PORT:-3100}" # :3000 is often held by another local project
STACK=apps/web/e2e/local-stack.sh
RUN="${TMPDIR:-/tmp}/assessiq-e2e"

listen_pid() {
  if command -v netstat >/dev/null 2>&1 && netstat -ano >/dev/null 2>&1; then
    netstat -ano | tr -d '\r' | awk -v p=":$1" '$2 ~ p"$" && /LISTENING/ {print $NF; exit}'
  else lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; fi
}
cleanup() { bash "$STACK" --down >/dev/null 2>&1; }
trap cleanup EXIT

echo "STEP 1/4 build apps/web"
pnpm --filter @assessiq/web build >"$RUN.build.log" 2>&1 || { tail -n 30 "$RUN.build.log" >&2; echo "FAIL build" >&2; exit 1; }

echo "STEP 2/4 start local stack"
bash "$STACK" --down >/dev/null 2>&1 # clear leftovers from an earlier run
bash "$STACK" || { echo "FAIL local stack" >&2; exit 1; }

echo "STEP 3/4 serve the build (replaces the dev server on :5173)"
bash -c 'pid=$(cat "$1"); if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //T //F >/dev/null 2>&1; else kill "$pid"; fi' _ "$RUN/web.pid"
for _ in $(seq 1 20); do [ -z "$(listen_pid 5173)" ] && break; sleep 1; done
(
  export E2E_API_PROXY=http://127.0.0.1:$E2E_API_PORT
  cd apps/web && nohup node_modules/.bin/vite preview --port 5173 --strictPort >"$RUN/preview.log" 2>&1 &
)
for _ in $(seq 1 30); do curl -fs http://localhost:5173/ >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://localhost:5173/ >/dev/null || { echo "FAIL preview did not start; see $RUN/preview.log" >&2; exit 1; }
listen_pid 5173 >"$RUN/web.pid" # so `local-stack.sh --down` stops the preview too

echo "STEP 4/4 signed-in smoke spec"
PLAYWRIGHT_BASE_URL=http://localhost:5173 E2E_API_BASE_URL=http://localhost:$E2E_API_PORT \
  pnpm --filter @assessiq/web exec playwright test signed-in-smoke --project=chromium
rc=$?
[ "$rc" -eq 0 ] && echo "OK signed-in check passed" || echo "FAIL signed-in check (exit $rc)" >&2
exit "$rc"
