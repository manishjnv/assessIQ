# AssessIQ — tools/ catalog

Ops and dev CLI helpers. All scripts are designed for `pnpm exec tsx <script>` inside the
`assessiq-api` container (or locally with `DATABASE_URL` set).

---

## aiq-import-pack.ts

Bulk-import a question pack from a JSON file into a named tenant.
Bridges the gap until the Phase-2 admin-UI upload widget ships (module 10).

```bash
pnpm exec tsx tools/aiq-import-pack.ts --tenant <slug> <pack-file.json>
```

---

## cleanup-stale-drafts.ts

**Purpose:** Archive `ai_draft` questions that have not been promoted or
discarded after N days. Smoke-run campaigns leave dozens of draft rows per
pack; this tool sweeps them in bulk without requiring the per-pack
click-through in the admin UI.

**Default:** `--dry-run` (print-only). No rows are written unless `--apply`
is passed.

**Args:**

| Flag | Default | Description |
|---|---|---|
| `--older-than-days <int>` | `7` | Archive drafts older than this many days |
| `--pack-id <uuid>` | *(all packs)* | Scope to a single question pack |
| `--apply` | `false` | Write the UPDATE (omit = dry-run) |
| `--quiet` | `false` | Suppress the row table; still prints the summary line |

**Role-elevation:** Uses `SET LOCAL ROLE assessiq_system` (BYPASSRLS) inside a
transaction for cross-tenant access. The privilege is scoped to the
transaction only and reverts on COMMIT/ROLLBACK.

**Example invocations:**

```bash
# Dry-run inside the api container — lists the ~50 stale ai_draft rows
docker exec -w /app/apps/api assessiq-api pnpm exec tsx \
  /app/tools/cleanup-stale-drafts.ts --older-than-days 7

# Archive all ai_draft rows older than 7 days (ops confirmed)
docker exec -w /app/apps/api assessiq-api pnpm exec tsx \
  /app/tools/cleanup-stale-drafts.ts --older-than-days 7 --apply

# Scope to a single pack, dry-run
docker exec -w /app/apps/api assessiq-api pnpm exec tsx \
  /app/tools/cleanup-stale-drafts.ts --older-than-days 3 \
  --pack-id 019df000-44f3-7c97-9403-f7bde6a36843
```

**Output (dry-run):**

```
Found 52 ai_draft questions older than 7 days, across 1 pack.
Affected: 52
id                                    type          topic                                                           age_days
--------------------------------------------------------------------------------------------------------------------------------------
019e0cc5-...                          mcq           Network segmentation and micro-segmentation in SOC env…       8.3
...
Run with --apply to archive.
```

**Frequency:** Weekly cron, or after every smoke campaign that leaves
`ai_draft` rows. The UPDATE is idempotent: a second run on an already-
archived batch returns `Affected: 0`.

---

## cleanup-orphaned-attempts.ts

**Purpose:** Mark `running` `generation_attempts` rows that have been idle
for more than N minutes as `failed` with `error_code='ORPHANED'`. The
`try/finally` finalize block in `handleAdminGenerate` (commit f449203)
handles the common case, but container SIGTERM can race the finalize block.
This sweep keeps the table clean until the root cause is resolved.

**Default:** `--dry-run` (print-only). No rows are written unless `--apply`
is passed.

**Args:**

| Flag | Default | Description |
|---|---|---|
| `--older-than-minutes <int>` | `30` | Threshold in minutes for `running` rows |
| `--apply` | `false` | Write the UPDATE (omit = dry-run) |
| `--quiet` | `false` | Suppress the row table; still prints the summary line |

**Role-elevation:** Uses `SET LOCAL ROLE assessiq_system` (BYPASSRLS) inside a
transaction for cross-tenant access. Same security model as `cleanup-stale-drafts`.

**Example invocations:**

```bash
# Dry-run — list orphaned running attempts (likely 0 after manual cleanup)
docker exec -w /app/apps/api assessiq-api pnpm exec tsx \
  /app/tools/cleanup-orphaned-attempts.ts --older-than-minutes 30

# Mark orphaned (ops confirmed)
docker exec -w /app/apps/api assessiq-api pnpm exec tsx \
  /app/tools/cleanup-orphaned-attempts.ts --older-than-minutes 30 --apply
```

**Output (apply):**

```
Found 1 orphaned running attempt older than 30 minutes.
Affected: 1
Marked 1 attempt failed (ORPHANED). Done.
```

**Frequency:** Hourly cron, or on-demand after a deploy that may have killed
in-flight generation (e.g. `docker compose up --force-recreate assessiq-api`).

---

## stage1-sharded-smoke.ts

One-shot smoke runner for the sharded generation path. Invokes
`handleAdminGenerate` directly (bypasses HTTP/auth). Targets WIPRO-SOC L2
with a fixed question count.

```bash
docker exec assessiq-api pnpm exec tsx /app/tools/stage1-sharded-smoke.ts
```

---

## migrate.ts

Database migration runner. Discovers and applies SQL files under
`modules/*/migrations/`. See `docs/06-deployment.md` § Migrations.

---

## lint-deploy-procedure.ts

Pre-deploy lint gate: checks skill bind-mounts, migration paths, env var
coverage, and email template URL consistency. Run before opening any PR.

```bash
pnpm tsx tools/lint-deploy-procedure.ts
```

---

## test-invite.ts

Dev helper: create a test invitation for a candidate without going through
the full admin UI flow.

---

## generate-help-seed.ts

Regenerate the help content seed SQL from the help system module's
canonical JSON.

---

## inspect-attempt.sh

One-liner wrapper: dump the full diagnostic surface of a
`generation_attempts` row when a smoke run exits non-zero.

```bash
./tools/inspect-attempt.sh <attempt-id>
```

---

## lint-cross-module-deps.ts / lint-edge-routing.ts / lint-logging-discipline.ts / lint-mv-tenant-filter.ts / lint-rls-policies.ts

Structural lint gates for cross-module import constraints, edge routing,
logging discipline, materialized-view tenant filter, and RLS policy
completeness. Run from CI or pre-commit.
