# 06 — Deployment

*Type: how-to* — This page gives the steps to deploy, roll back and operate AssessIQ on the shared VPS.

> **Status:** the team rewrote this page on 2026-04-30 to reflect the actual VPS state. The earlier draft assumed nginx + certbot. In reality, **Caddy** is the global TLS edge, **Cloudflare** sits in front, and **other apps already run on the box** (`ti-platform`, `accessbridge`, `roadmap`).

This page gives the procedures to deploy, roll back and operate AssessIQ on the shared VPS. Each procedure has one goal and numbered steps with the exact commands. Background blocks explain facts that are not steps. The dated deploy log is at the end, under "Deploy history".

## Prerequisites

Complete these items before you run any procedure.

- You have SSH access through the alias `assessiq-vps` (host `srv1150121.hstgr.cloud`).
- `/srv/assessiq` is a git clone. Run `test -d /srv/assessiq/.git || echo "WARNING: not a git clone"` to check.
- Every change is additive. You touch only AssessIQ paths and containers: `/srv/assessiq/`, `/var/log/assessiq/`, `/var/backups/assessiq/`, containers with the prefix `assessiq-`, and one server block in the ti-platform Caddyfile.
- Before you touch `apt`, `docker`, `systemctl`, Caddy or a shared config, list what runs first: `docker ps`, `systemctl list-units --state=running --no-pager`, the Caddy config and `crontab -l`.
- Never run a blanket cleanup on this host. Do not run `docker system prune -a`, `apt autoremove` or `certbot renew --force-renewal`.

## Background: topology and layout

This block explains what runs on the host and where the files live. It has no steps.

### Target topology — actual

The shared Hostinger VPS (`srv1150121.hstgr.cloud`, alias `assessiq-vps`) already runs three apps. AssessIQ is additive. Caddy (owned by ti-platform) is the only service bound to host ports 80/443. Everything else sends traffic upstream through it. Cloudflare orange-cloud proxies the public domain.

```text
                    Internet
                       │
                       ▼
              ┌─────────────────┐
              │   Cloudflare    │   TLS edge (CF managed cert)
              │   (orange ☁)    │   WAF + rate limit
              └────────┬────────┘
                       │  origin pull (Full Strict)
                       ▼
              ┌─────────────────┐
              │  ti-platform-   │   :80→:443 redirect
              │  caddy-1        │   :443 → upstreams via host gateway
              │ (Caddy global)  │   /etc/caddy/ssl/assessiq.* (CF Origin Cert)
              └────────┬────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼              ▼
   ti-platform     roadmap-web    accessbridge    OTHERS       AssessIQ
   stack           :8090          :8080-:8300                  127.0.0.1:9091
                                                                    │
                                                                    ▼
                                              ┌─────────────────────────────────┐
                                              │    /srv/assessiq/  (this repo)  │
                                              │                                 │
                                              │  assessiq-frontend  → 9091 host │
                                              │  assessiq-api       → internal  │
                                              │  assessiq-worker    → internal  │
                                              │  assessiq-postgres  → volume    │
                                              │  assessiq-redis     → volume    │
                                              │                                 │
                                              │  Network: assessiq-net (bridge) │
                                              └─────────────────────────────────┘
```

**Not on this box, not in this stack:**

- Nginx (Caddy is the edge).
- Certbot (Cloudflare manages the public cert, and the CF Origin Cert is for origin pull).
- Direct calls to the Anthropic API (Phase 1 grading uses the Claude Code CLI under the Max account of the admin; see `docs/05-ai-pipeline.md` and `CLAUDE.md` rule #1).

### VPS layout — file paths

| Path | Owner | Purpose |
| --- | --- | --- |
| `/srv/assessiq/` | this repo | docker-compose.yml, .env, Dockerfiles, migrations seed dir |
| `/srv/assessiq/data/` | this app | Bind mounts for `pgdata`, `redis-data`, `uploads/` (named volumes are preferred; use a bind mount only if a host-side tool needs to read the data) |
| `/var/log/assessiq/` | this app | Per-stream JSONL operational logs (`app.log`, `request.log`, `auth.log`, `grading.log`, `migration.log`, `webhook.log`, `frontend.log`, `error.log` mirror). The schema, redaction, retention and triage runbooks live in [docs/11-observability.md](11-observability.md). This doc documents the disk topology only. Owner `assessiq:assessiq`, mode `0750`. Bind-mounted into containers at the same host path. System `logrotate` rotates it daily with `copytruncate` (config at `infra/logrotate.d/assessiq`, symlinked into `/etc/logrotate.d/`; see § "Log directory + rotation — apply procedure" below). |
| `/var/backups/assessiq/` | this app | nightly pg_dump destination |
| `/opt/ti-platform/caddy/Caddyfile` | **ti-platform (shared!)** | Global Caddy config. AssessIQ adds **one server block** here and never edits anything else |

**Hard rule (CLAUDE.md #8 reaffirmed):** The deploy diff of AssessIQ may (a) create files under the four `assessiq`-prefixed paths above and (b) **append** one server block to the ti-platform Caddyfile. Anything else on this box is off-limits without explicit user approval.

### Scale-out path

The path is the same as before: API replicas → managed Postgres → worker pool → multi-region. None of this changes with the Caddy-fronted topology. When AssessIQ moves off the shared VPS, it takes its own ingress (a fresh nginx or its own Caddy) with it, and Cloudflare only points to the new origin.

### Out of scope for Phase 0 deployment

- Anthropic API key wiring (Phase 2 only; Phase 1 uses the Claude Code CLI).
- Self-managed Let's Encrypt for the public cert (Cloudflare handles the edge, and the CF Origin Cert handles the origin).
- Per-tenant custom domains (Phase 3+).
- HA Postgres / Redis (Phase 4+, if a client demands it).
- Sentry integration (placeholder env var; wire it when someone creates an account).

## Set up the log directory and rotation

**Goal:** create `/var/log/assessiq` and rotate its logs. Run this one time on a fresh VPS or on the first deploy that turns on logging.

This procedure is one-time and additive. Run it on a fresh VPS or on the first deploy that turns on observability:

```bash
# 1. Create the namespaced log dir (operator-owned, AssessIQ-prefixed).
sudo mkdir -p /var/log/assessiq
sudo chown assessiq:assessiq /var/log/assessiq
sudo chmod 0750 /var/log/assessiq

# 2. Symlink the committed logrotate config into /etc/logrotate.d/.
#    Linking (vs copying) means future repo changes apply on next pull.
sudo ln -sfn /srv/assessiq/infra/logrotate.d/assessiq /etc/logrotate.d/assessiq

# 3. Validate the config (dry-run; prints what would happen).
sudo logrotate -d /etc/logrotate.d/assessiq

# 4. Force a first rotation (creates the empty rotation state file).
sudo logrotate -f /etc/logrotate.d/assessiq

# 5. Confirm the assessiq-api / assessiq-worker containers see the bind mount.
docker exec assessiq-api ls -la /var/log/assessiq      # expect: writable by container user
```

`copytruncate` is load-bearing. Pino holds open file descriptors. Without `copytruncate`, the rotated file continues to receive writes while the new file stays empty. This is the same trap class as the Caddy bind-mount inode RCA (`docs/RCA_LOG.md` 2026-04-30). See `docs/11-observability.md § 7` for the rationale and the in-config explanation.

Set `LOG_DIR=/var/log/assessiq` in `/srv/assessiq/.env`, so `00-core` activates the on-disk JSONL fan-out (without it, all logs go only to stdout / Docker json-file). After the first set, restart the `assessiq-api` and `assessiq-worker` containers: `docker compose -f /srv/assessiq/docker-compose.yml up -d assessiq-api assessiq-worker`.

## Run the pre-deploy lint gates

**Goal:** find a missing operational dependency before you deploy. Run the lint locally, or read the CI result.

Four automated CI checks run in `.github/workflows/ci.yml` (step 12) through `pnpm lint:deploy-procedure`. Each check is independent. A violation in any one check exits 1 and blocks the PR. Exit 0 means all four checks are clean. Exit 2 means the lint itself hit an internal error (missing file, parse failure).

`score-goldens` runs in CI as the AI generation eval gate. Failures block the merge. The evidence is in the CI step log under "AI generation eval gate".

Run locally:
```bash
pnpm lint:deploy-procedure            # full repo scan — shows violations with file:line + fix hint
pnpm lint:deploy-procedure:self-test  # validates the lint logic itself (17 assertions); run after editing the lint
pnpm lint:deploy-procedure --json     # machine-readable JSON output for scripted checks
```

RCA reference: the `docs/RCA_LOG.md` 2026-05-08 entry documents the three incident classes (skill mount, env var, template URL) that drove the creation of this lint.

### CHECK A — Skill bind-mount integrity

**What it catches:** A skill is committed under `prompts/skills/<name>/SKILL.md`, but `infra/docker-compose.yml` has no volume mount that maps the skills directory into `assessiq-api` (and `assessiq-worker`). The running container reads the baked-in filesystem of the image. `git pull` alone cannot update skills that are not bind-mounted.

**Inverse:** If the mount exists but `prompts/skills/` contains no `SKILL.md` files, the lint also fires (dead bind-mount).

**Last incident:** 2026-05-08 — the skill was committed, but the runtime could not see it. Root cause: the team added the bind-mount after the fact.

**Canonical fix:**
```yaml
# infra/docker-compose.yml → services.assessiq-api.volumes (and assessiq-worker.volumes)
- ../prompts/skills:/home/node/.claude/skills:ro
```

### CHECK B — Migration apply chain

**What it catches:** A `.sql` file under `modules/` or `apps/` is not at the exact depth `modules/<name>/migrations/<file>.sql`, which is the only pattern that `tools/migrate.ts` discovers. The deploy silently skips a file at `modules/foo/subdir/migrations/001.sql` or `apps/api/seeds/001.sql`. The schema then diverges from the code without any error at startup.

**Exemption (manual migrations):** SQL files that the migration runner intentionally does not run (fixtures, reference data, seed scripts) may carry this comment at the top of the file to suppress the violation:
```sql
-- DEPLOY: manual; not part of migration sequence
```

**Canonical fix for a violation:** Move the file to `modules/<name>/migrations/<file>.sql`, or add the exemption marker and document the manual apply step below under § Migrations.

### CHECK C — Env var declaration coverage

**What it catches:** `process.env.VAR_NAME` is referenced in production source code, but `VAR_NAME` does not appear anywhere in `.env.example`, not even in a comment. Operators who provision a fresh deployment cannot see that the variable exists or what it should contain.

**Last incident:** 2026-05-08 — `SMTP_URL` was in the `config.ts` Zod schema and used in code, but absent from `.env.example`. The email feature silently fell back to the dev stub on production.

**Skip list** (exempt by default; standard Node/CI system vars that are never in `.env.example`):
`NODE_ENV`, `NODE_VERSION`, `HOME`, `PATH`, `USER`, `HOSTNAME`, `SHELL`, `PWD`, `OLDPWD`,
`TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TMP`, `TEMP`, `XDG_RUNTIME_DIR`, `LOGNAME`,
`CI`, `GITHUB_ACTIONS`, `GITHUB_TOKEN`, `GITHUB_WORKSPACE`, `GITHUB_SHA`, `GITHUB_REF`,
`RUNNER_OS`, `PORT`, `LOG_DIR`.

**Canonical fix for a violation:** Add a placeholder line and an explanatory comment to `.env.example`. If the var is optional with a sensible default, declare it as `z.optional()` or `z.default()` in `modules/00-core/src/config.ts`.

**Pre-existing violations on current main** (punch list as of 2026-05-08; the team tracks them as follow-up sessions):

| Var | Read at | Action |
| --- | --- | --- |
| `ASSESSIQ_PUBLIC_URL` | `modules/05-assessment-lifecycle/src/service.ts:85` | Alias for `ASSESSIQ_BASE_URL`; remove it or alias it in config.ts |
| `ASSESSIQ_DEV_EMAILS_LOG` | `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts:1148` | Dev-only email log path; add it to `.env.example` with a comment |
| `AIQ_ADMIN_USER_ID` | `modules/07-ai-grading/eval/cli.ts:609` | Eval CLI override; add it to `.env.example` as optional |
| `S3_BUCKET` | `modules/14-audit-log/src/archive-job.ts:65` | Audit-log S3 archive target; add it to `.env.example` |
| `ENABLE_EMBED_TEST_MINTER` | `apps/api/src/routes/auth/embed.ts:173` | Embed test gate; add it to `.env.example` with a note that production = false |
| `ENABLE_E2E_TEST_MINTER` | `apps/api/src/__tests__/routes/mint-session.test.ts:192` | It is in `config.ts` but missing from `.env.example`; add a line |
| `PLAYWRIGHT_BASE_URL` | `apps/web/e2e/fixtures/factories.ts:24` | E2E test base URL; add it to `.env.example` under the E2E section |
| `E2E_API_BASE_URL` | `apps/web/e2e/fixtures/factories.ts:25` | E2E API base URL; add it to `.env.example` under the E2E section |
| `E2E_CANDIDATE_TOKEN` | `apps/web/e2e/take-happy-path.spec.ts:7` | E2E fixture token; add it to `.env.example` under the E2E section |

### CHECK D — Email template URL ↔ SPA route consistency

**What it catches:** Two cases:

- A URL path that email-sending service code constructs (template literal `${base}/path/${segment}`) uses a first segment that the SPA does not register as a route in `apps/web/src/App.tsx`.
- A hardcoded `href` in a template HTML file does the same.

The candidate clicks the link and lands on the 404 catch-all of the SPA.

**Last incident:** 2026-05-04 — `modules/05-assessment-lifecycle/src/service.ts` built invitation links as `${PUBLIC_URL}/invite/${token}`. The SPA has no `/invite/:token` route. `/take/:token` is the correct candidate entry point. Candidates clicked the link and saw the 404 fallback.

**What is intentionally NOT checked:** Pure Handlebars placeholders (`href="{{invitationLink}}"`), because the caller supplies the URL and the template does not embed it. The check also skips `https://` absolute URLs without a literal path fragment.

**Canonical fix for a violation:** Either update the URL in the service code or the template to use a registered SPA route, or add the missing route to `apps/web/src/App.tsx`. See `modules/13-notifications/src/__tests__/notifications.test.ts` for the regression guard that asserts `/take/` in candidate invitation emails.

### Pre-deploy lint gates: full listing and CHECK B.2

This listing repeats the four checks and adds the migration-drift gate.

> **Added 2026-05-08.** These CI lints run on every PR in `.github/workflows/ci.yml` (deterministic-gates job, steps 8–12). They catch the "code shipped, operational dependency missed" class of bugs that caused repeated production incidents between 2026-05-03 and 2026-05-08. See `docs/RCA_LOG.md` for the originating incidents.

Run locally before opening a PR:

```bash
pnpm tsx tools/lint-deploy-procedure.ts
```

Or run a specific check with `--json` for machine-readable output, and use `--self-test` to validate the lint itself.

#### CHECK A — Skill bind-mount integrity

**What it catches:** Skill files under `prompts/skills/<name>/SKILL.md` that exist in the repo but that `infra/docker-compose.yml` does not bind-mount into the `assessiq-api` and `assessiq-worker` containers. It also detects the inverse: docker-compose declares a mount, but the `prompts/skills/` directory contains no `SKILL.md` files.

**Why it exists:** On 2026-05-08, the question-generator feature was blocked for hours because the container did not mount the `prompts/skills/` directory. The skills were on the VPS host but invisible inside the running API. The fix required 3 commits and a compose rebuild.

**Canonical fix for violations:**

- `SKILL UNREACHABLE`: Add a read-only bind-mount in `infra/docker-compose.yml` under `services.<name>.volumes`. It maps `../prompts/skills` to the skills directory inside the container. See the existing `assessiq-api` volumes block for the correct pattern.
- `SKILL MOUNT EMPTY`: Either add `SKILL.md` files under `prompts/skills/<name>/` or remove the dead bind-mount.

#### CHECK B — Migration apply chain

**What it catches:** SQL files anywhere under `modules/` or `apps/` that are NOT at the exact depth `modules/<name>/migrations/<file>.sql`, which is the only path pattern that `tools/migrate.ts` discovers. The runner cannot see a SQL file at `modules/foo/subdir/migrations/001.sql`, so it never applies the file and silently leaves the schema stale.

**Why it exists:** Someone can add migration files at non-standard paths (for example, in a subdirectory or under `apps/`). The commit succeeds, and the files appear in git history. But the deploy never applies them. The schema silently diverges from the code.

**Canonical fix for violations:**

- `MIGRATION ORPHAN`: Move the file to `modules/<name>/migrations/<basename>.sql`, so that the runner discovers it. Or add the exemption marker at the top of the file, `-- DEPLOY: manual; not part of migration sequence`, and document the manual apply step in this doc under § Migrations.

**Exemption marker** (for seed files, reference data or ad-hoc fixes that someone applies out of band):
```sql
-- DEPLOY: manual; not part of migration sequence
-- Reason: <explain why this SQL is not part of the automated migration sequence>
```

#### CHECK B.2 — Migration-drift gate (`pnpm tsx tools/migrate.ts --check`)

**What it catches:** A `.sql` migration file exists in the repo under `modules/*/migrations/`, but the `schema_migrations` table of the live DB does not record it. Or the stored checksum of a recorded migration no longer matches the content of the file on disk. Both states block a clean deploy. In the first state, the deployed code expects a table, column or index that does not exist. In the second state, someone edited the file after the team applied it, which silently fragments the history across environments.

**Why it exists:** RCA `2026-05-13 — Verify path silently 404/500 in prod`. The team committed migrations `0046_certification_init.sql` (Phase 5 Session 1, 2026-05-11) and `0074_public_verify_policy.sql` (Phase 5 Session 3) and deployed the Fastify code that depended on them. But nobody ever applied either migration to the VPS DB. The certificates table did not exist for two sessions. Every `/verify/*` request returned HTTP 500 in prod. Nothing in the user-facing app linked to `/verify/*` yet, so nobody noticed. A pre-deploy `--check` would have failed loudly and refused to ship.

**How to run** (it requires a postgres-superuser `DATABASE_URL`; the `assessiq_app` role that the running API uses cannot write `schema_migrations`):

```bash
DATABASE_URL='postgres://postgres:…@host:5432/assessiq' \
  pnpm tsx tools/migrate.ts --check
```

Exit 0 → the repo and `schema_migrations` are in sync. It is safe to deploy.
Exit 1 → at least one pending migration **or** at least one drifted checksum. The JSONL log lists each offending file under `migration.check.pending` / `migration.check.drift` events. Resolve the findings before you proceed to `docker compose build` / `up -d`.

**Canonical fix for violations:**

- `migration.check.pending`: run `pnpm tsx tools/migrate.ts` (no `--check`) against the same `DATABASE_URL` to apply the missing migration(s). Then run `--check` again to confirm exit 0.
- `migration.check.drift`: someone edited a recorded migration after the team applied it. This is almost always a mistake (migrations are append-only). Investigate before you proceed. Suppose the edit is genuinely intentional (rare; for example a typo-only fix in a comment). Then use `--force-rerun <basename>` against the affected DB to record the new checksum again. Otherwise revert the edit, so that the on-disk content matches what the team applied.

**Production note:** the deploy gate does not run `--check`. It uses a `diff` that tolerates four known DB-only names. See "How to read the drift diff" under [Deploy procedure](#deploy-procedure-steady-state-post-2026-05-03).

#### CHECK C — Env var declaration coverage

**What it catches:** `process.env.VAR_NAME` reads in `modules/*/src/` and `apps/*/src/` where `VAR_NAME` does not appear anywhere in `.env.example` (including comment mentions). This catches vars that code uses but that nobody documented for operators who provision a new environment.

**Why it exists:** On 2026-05-08 the SMTP email feature was delayed because nobody provisioned `SMTP_URL` on the VPS. It was in the config schema, but operators did not know to set it. This check ensures that `.env.example` shows every env var that the codebase consumes.

**Standard skip list** (the check does not flag them): `NODE_ENV`, `HOME`, `PATH`, `USER`, `HOSTNAME`, `SHELL`, `CI`, `GITHUB_ACTIONS`, `PORT`, and other standard Node/OS/CI variables. See `SKIP_ENV_VARS` in `tools/lint-deploy-procedure.ts`.

**Canonical fix for violations:**
- `ENV VAR UNDECLARED`: Add a placeholder entry to `.env.example`:
  ```
  # VAR_NAME — short description of what this variable controls.
  # Example: VAR_NAME=example-value  (or leave blank if it's a secret)
  VAR_NAME=
  ```
  If the variable is truly optional with a sensible default, also declare it in `modules/00-core/src/config.ts` as `z.optional()` or `z.default(...)`.

#### CHECK D — Email template URL ↔ SPA route consistency

**What it catches:** Two patterns:
1. HTML email templates (`modules/13-notifications/src/email/templates/*.html`) with hardcoded `href="/path/..."` attributes that do not match any `<Route path="...">` entry in `apps/web/src/App.tsx`.
2. Email-sending service code (modules 03, 05, 13) that constructs URL paths via template literals (`${base}/path/${segment}`) or string concatenation where the path prefix has no matching SPA route.

**Why it exists:** On 2026-05-04 (RCA: "candidate invitation URL /invite/ vs /take/"), `modules/05-assessment-lifecycle/src/service.ts` built invitation links as `${PUBLIC_URL}/invite/${token}`. The SPA has no `/invite/:token` route. Candidates clicked the link and landed on the 404 page. The fix was a 1-line change, but the team had to diagnose it from a live email log.

**Canonical fix for violations:**

- `TEMPLATE URL MISMATCH`: Either fix the URL path in the template or service code to use a registered SPA route (check `apps/web/src/App.tsx`), OR add the missing route to the SPA. Make the fix in BOTH places if someone intentionally omitted the route. Do not patch the URL around a missing route.

## Deploy procedure (steady-state, post-2026-05-03)

**Goal:** ship a committed change to production. Follow the steps in order.

As of 2026-05-03, `/srv/assessiq` is a `git clone` of `manishjnv/assessIQ`. The old `git archive + scp + tar-extract` rsync flow is **deprecated**. See RCA 2026-05-03 "Architectural debt: /srv/assessiq is not a git clone". All future deploys use this procedure:

```bash
# 1. Pull latest main
ssh assessiq-vps 'cd /srv/assessiq && git pull'

# 2. Migration-drift gate (CHECK B.2) — MANDATORY before rebuild.
#    --check exits non-zero if any modules/*/migrations/*.sql is missing
#    from schema_migrations or any recorded checksum has drifted.
#    Runs inside the postgres container so it connects as the superuser
#    role with permission to write schema_migrations.
ssh assessiq-vps 'docker compose -f /srv/assessiq/infra/docker-compose.yml exec -T \
  assessiq-postgres psql -U assessiq -d assessiq -tA -c \
  "SELECT version FROM schema_migrations ORDER BY version"' \
  | sort > /tmp/db-migrations.txt
ssh assessiq-vps 'ls /srv/assessiq/modules/*/migrations/*.sql | xargs -n1 basename' \
  | sort > /tmp/repo-migrations.txt
# Tolerates only the four known DB-only names (see "How to read the drift diff").
if diff /tmp/repo-migrations.txt /tmp/db-migrations.txt \
  | grep -v -E '^[0-9]+(,[0-9]+)?[acd][0-9]+(,[0-9]+)?$' \
  | grep -v -E '^> (0011_seed_help_content\.sql|0100_attempts_ai_proposals_cache|0106_generation_attempts_batch_id|0109_seed_platform_aptitude_pack\.sql)$' \
  | grep .; then
  echo "MIGRATION DRIFT — apply pending or reconcile before deploying"; exit 1
fi

# 2b. If --check (or the diff above) shows pending migrations, apply them
#     BEFORE rebuilding any container image. Run from a host with a
#     postgres-superuser DATABASE_URL pointed at the production DB:
ssh assessiq-vps 'docker exec -i assessiq-postgres psql -U assessiq -d assessiq \
  -v ON_ERROR_STOP=1 < /srv/assessiq/modules/<name>/migrations/<file>.sql'
# Record in schema_migrations with the file's SHA256:
ssh assessiq-vps 'sha256sum /srv/assessiq/modules/<name>/migrations/<file>.sql'
ssh assessiq-vps 'docker exec assessiq-postgres psql -U assessiq -d assessiq -c \
  "INSERT INTO schema_migrations(version, checksum) VALUES (\"<file>.sql\", \"<sha256>\");"'

# 3. Rebuild the changed service image
ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml build <service> 2>&1 | tail -10'
# <service> is one of: assessiq-api, assessiq-frontend (rebuild both if in doubt)

# 4. Recreate the container
ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate <service>'
```

#### How to read the drift diff

The gate in step 2 compares the repo file list with `schema_migrations`. Production is expected to show exactly four extra DB-only names (checked 2026-10-16, HEAD `b3bcfb4`: 150 repo files, 154 DB rows).

| Name in DB only | Why it has no repo file | Since |
| --- | --- | --- |
| `0011_seed_help_content.sql` | Moved to `modules/16-help-system/seeds/help_content.sql` | 2026-10-11 |
| `0100_attempts_ai_proposals_cache` | Recorded by hand without `.sql`; the team renamed the repo file later | May 2026 |
| `0106_generation_attempts_batch_id` | Recorded by hand without `.sql`; the team renumbered the repo file later | May 2026 |
| `0109_seed_platform_aptitude_pack.sql` | One-off seed with no repo file | 2026 |

- A `<` line is a repo file that the team has not applied yet. Apply it by hand before the rebuild. See [Apply new migrations by hand](#apply-new-migrations-by-hand-pattern-used-2026-10-01).
- A `>` line is recorded in the DB but has no repo file. Only the four names above are allowed. Any other `>` line is an incident.
- `tools/migrate.ts --check` has no allowlist, and you do not use it against production. See the paragraph in [Apply new migrations by hand](#apply-new-migrations-by-hand-pattern-used-2026-10-01).

> **Why step 2 is mandatory:** RCA `2026-05-13 — Verify path silently 404/500 in prod`. The team committed migrations `0046_certification_init.sql` and `0074_public_verify_policy.sql` and deployed the dependent code across multiple sessions, but nobody ever applied either migration. The verify feature silently returned 500 in prod for two sessions, until a Session 7 smoke showed the gap. A pre-deploy diff between `ls modules/*/migrations/*.sql` and `SELECT version FROM schema_migrations` would have caught it immediately. Treat step 2 as a hard gate, not a courtesy check.

**If `.env` changes:** use `up -d --force-recreate` (NOT `restart`). See RCA 2026-05-01 "docker compose restart does NOT reload env_file".

**Smoke after every deploy:**
```bash
ssh assessiq-vps 'docker ps --format "{{.Names}} {{.Status}}" | grep assessiq'
curl -sI https://assessiq.automateedge.cloud/api/health  # expect HTTP/2 200
# Verify no restart-loop: docker logs --tail 20 assessiq-api 2>&1 | grep -i 'syntaxerror\|module.*does not provide'
```

**NOTE:** The team preserved `/srv/assessiq.old` (the rsync copy from before the conversion) at `/srv/assessiq.old` until 2026-05-10 for rollback safety. After that date, you can safely run `rm -rf` on it.

## Deploy a source-only change

**Goal:** deploy a code change that has no schema change and no new skill.

```bash
git pull --ff-only
docker compose -f /srv/assessiq/infra/docker-compose.yml build assessiq-api
docker compose -f /srv/assessiq/infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api
```
`--force-recreate` alone is insufficient. The Dockerfile bakes the source into the image, so every code change needs a rebuild.

## Deploy a skill change

**Goal:** change a grading or generation prompt skill on the VPS.

> **CHANGED 2026-10-01: prompts are no longer in git.**
>
> - **Why:** the repo is public, and the grading and generation prompts are product IP, so the team untracked `prompts/skills/` and put it in `.gitignore`.
> - **Source of truth:** the VPS host copy at `/srv/assessiq/prompts/skills/`. A local working copy stays on the laptop (ignored), and the daily backup writes `prompts-skills-<ts>.tgz` to `/var/backups/assessiq/`.
> - **Container mount:** unchanged (`../prompts/skills:/home/node/.claude/skills:ro`).
> - **Deploying a skill change:** `git pull` no longer does it. Copy the edited file instead: `scp prompts/skills/<name>/SKILL.md assessiq-vps:/srv/assessiq/prompts/skills/<name>/SKILL.md`. That is the whole deploy (the system re-reads the file on every call). But also rebuild the api image if the runtime schema changed, and re-baseline the evals.
> - **One-time cutover (2026-10-01):** the untracking commit makes the next `git pull` on the VPS delete the folder. So back it up before the pull (`cp -a prompts/skills /root/assessiq-skills-backup-<ts>`), restore it right after (`cp -a … prompts/skills`), and then **recreate** api and worker, because the bind mount pinned the deleted directory inode. The team checked the sha256 of every SKILL.md before and after.
> - **Lint:** `tools/lint-deploy-procedure.ts` CHECK A now treats a missing folder (a fresh CI checkout) as normal.
> - The `git pull` steps below are historical.

The system bind-mounts the skills in `prompts/skills/` read-only into the `assessiq-api` and `assessiq-worker` containers at `/home/node/.claude/skills/` (relative path `../prompts/skills` from `infra/docker-compose.yml`). **Since 2026-10-01, a `git pull` does not deploy skill changes.** Use `scp` to copy the file into `/srv/assessiq/prompts/skills/` on the VPS (see the box above). A skill-only change needs no container restart.
The system re-reads the skill file from disk on every `skillSha()` invocation. *History: before 2026-10-01, a `git pull` alone was enough.*

```bash
# On VPS — skill-only deploy:
cd /srv/assessiq && git pull --ff-only
# Verify the updated skill is readable:
docker exec assessiq-api head -3 /home/node/.claude/skills/generate-questions/SKILL.md
```

Post-deploy smoke (run after any skill change):
```bash
docker exec assessiq-api ls /home/node/.claude/skills/
# Expected: generate-questions  grade-anchors  grade-band  grade-escalate
```

## Claude CLI state mount pattern (2026-05-09, commits `607f636` and `de49d89`)

The container mounts the entire host claude state as a directory, not per file.
The container needs two mounts:

```yaml
- /root/.claude:/home/node/.claude:rw        # entire state directory
- /root/.claude.json:/home/node/.claude.json:rw  # config file (one level above dir)
```

> **[Update 2026-10-09: RW-11 (`e8c12cf`) supersedes this.]** The team removed the `/root/.claude.json` file bind above. The containers now set `CLAUDE_CONFIG_DIR=/home/node/.claude` and read `/root/.claude/.claude.json` inside the directory mount. The old rule "restart api and worker after a re-login" (a single-file bind follows the inode and goes stale) no longer applies. See the section "Hardening S2 deploy (2026-10-09)".

**Why whole-directory, not per-file:** claude upgrades introduce new state files
(`.credentials.json` was added in v2.1.137; older per-file mounts only listed
`oauth_token`, `oauth_token.expires`, `settings.json` and silently missed it).
A whole-directory mount picks up any new state files automatically, without YAML edits.

**Why `USER root`:** `.credentials.json` is mode 600 and owned by root. The container must run as root to read it. The image still sets the owner of the app files to node:node (`RUN chown -R node:node /app` runs before `USER root`), so the app itself runs fine. Trust model: single-tenant admin container. Isolation of the node user adds little real security when the container already bind-mounts the credential directory of the admin.

**`skills/` stays an `:ro` overlay:** `../prompts/skills` is overlaid read-only on top of the `.claude` directory mount, so that skill deploys with `git pull` only still work.

RCA reference: `docs/RCA_LOG.md` 2026-05-09 entry "claude auth state mount: per-file approach broken across version upgrades".

## Rebuild the MCP tools (2026-05-11, commit `ab39667`)

**Goal:** deploy a change to the `assessiq-mcp` tool source.

`tools/assessiq-mcp/` is bind-mounted read-only into `assessiq-api` at `/opt/assessiq-mcp`. TypeScript source compiles to `dist/tools/*.js` (one file per tool, **not** into `dist/server.js`). The system spawns the MCP server fresh for each Claude session, so it picks up the new dist immediately. No container recreate is required.

```bash
# On VPS — MCP tool source change deploy:
cd /srv/assessiq && git pull --ff-only
cd tools/assessiq-mcp && npm install --no-audit --no-fund && npx tsc

# Verify the target symbol landed in the right compiled file:
grep -c 'logRejection' /srv/assessiq/tools/assessiq-mcp/dist/tools/submit-questions.js
# Expected: 2  (function def + call site)

# Confirm container sees the new dist (bind mount — no recreate needed):
docker exec assessiq-api grep -c 'logRejection' /opt/assessiq-mcp/dist/tools/submit-questions.js
# Expected: same count
```

The rejection logger writes JSONL to `/var/log/assessiq/mcp-rejections.log` (bind-mounted rw from the VPS host). The logger creates the file on the first rejection. If the file is absent, no rejection has occurred yet. It is not a write failure.

## Apply new migrations by hand (pattern used 2026-10-01)

**Goal:** apply a migration to production when you do not use `tools/migrate.ts`.

`tools/migrate.ts` is not run against production today, because `--check` has no allowlist for the four known DB-only names (0011, 0100, 0106, 0109) and would always report drift. The tracker is otherwise complete: every repo migration is recorded in `schema_migrations`. The deploy gate (step 2 of the deploy procedure) uses a `diff` that tolerates only those four names. Apply new migrations one by one, in number order, **before** the image rebuild, because new code may read the new columns (for example `saveAnswer` reads 0119 `attempt_questions.option_order`).

1. **Pull:** `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
2. **Script:** write a small LF-only bash script on the laptop, `scp` it to `/tmp`, and run it with `ssh assessiq-vps 'bash /tmp/<script>.sh < /dev/null'`.
   - Do NOT pipe the script into `ssh … bash -s`. The `docker exec -i` inside it swallows stdin, and the run silently stops after the first command.
3. **One transaction per file, then record it:**
   ```bash
   PSQL="docker exec -i assessiq-postgres psql -U assessiq -d assessiq"
   $PSQL -1 -v ON_ERROR_STOP=1 -q < modules/<NN-module>/migrations/<file>.sql
   sha=$(sha256sum <that file> | cut -d' ' -f1)
   $PSQL -tA -c "INSERT INTO schema_migrations(version, checksum) VALUES ('<file>.sql', '$sha') ON CONFLICT DO NOTHING RETURNING version;"
   ```
4. **Post-checks in the same script:** check the new columns through `information_schema.columns`, the new policies through `pg_policies`, and the help-row counts. Then build and recreate as in the steady-state procedure:
   - `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`;
   - `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`. The worker uses the api image.
5. **Before recreating:** make sure that no AI grading run is in flight. `docker exec assessiq-api sh -c "ps -o args | grep -v grep | grep -c claude"` must print `0`.

**Quoting gotcha:** The remote shell mangles SQL that contains `$$` or nested quotes inside `ssh '…'` (`$$` becomes the PID of the shell). Put the SQL in a file and pipe it into `psql` (`docker exec -i … psql … < /tmp/q.sql`).

**Seeds (RW-40, 2026-10-11).** A hand-applied deploy does NOT run seeds. The steps above apply migrations only. `tools/migrate.ts` runs every `modules/*/seeds/*.sql` after the migrations, unless you pass `--skip-seeds`. A seed is idempotent, and `schema_migrations` does not record it. `--dry-run` lists the seeds as `seed.list`. A real run logs `seed.applied` for each file, or `seed.failed` and exit code 1. The first seed is `modules/16-help-system/seeds/help_content.sql`. Do not run it by hand on production, because the production help rows come from the forward migrations. For the reason and the effect on a fresh database, see `docs/02-data-model.md`, "Post-migration seeds".

The team applied these migrations this way on 2026-10-01:
- 0113–0116: scoring and result release, evaluation queue;
- 0117–0121: invitation resend, help, option shuffle, notifications UPDATE policies.

See `docs/plans/archive/SCORING_RESULT_RELEASE.md` and `docs/plans/archive/PILOT_READINESS_BATCH.md`.

## Roll back and stage (E8)

**Goal:** return to the previous build and decide what to do with newer migrations.

*History: 2026-10-02.*

**What changed:** a written rollback procedure and a staging decision. The team created nothing on the VPS.

**Rollback of a bad deploy (code only)**

1. On the VPS, run `cd /srv/assessiq && git log --oneline -5`. Pick the last good SHA.
2. Run `git checkout <prev-sha>` (a detached HEAD is expected).
3. Rebuild the changed services: `docker compose -f infra/docker-compose.yml build <svc>` (api, worker, frontend, marketing, as needed). The worker uses the api image.
4. Recreate only those services: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate <svc>`.
5. Verify that `/`, `/admin` and `/api/health` return 200, and that `docker logs --tail 50 assessiq-api` shows no errors. Before you recreate api or worker, make sure that no AI grading run is in flight.
6. When the fix has landed on main, run `git checkout main && git pull --ff-only`. Then deploy normally. Do not leave the VPS on a detached HEAD.
7. Never run `git clean -fdx` there. It deletes the gitignored `cases-private`, `runs`, `baselines` and `prompts/skills`.

**Migrations are forward-only.** Today you apply them by hand, one transaction per file, and record them in `schema_migrations` (see the section "Applying new migrations by hand"). The files live in `modules/*/migrations/`. There are no down migrations.

- **A rolled-back build meets a newer schema, additive migration** (new table, new nullable column, new index, new policy): leave it. The old code ignores it. This is the normal case.
- **Destructive or incompatible migration** (drop, rename, type change, NOT NULL without default, tightened CHECK or policy): do not hand-edit the schema. Write a numbered compensating migration, review it, and apply it with the same by-hand procedure. Then roll back the code. A destructive migration should name its compensating migration in its header before anyone deploys it.
- **Last resort: restore from backup.** The nightly `pg_dump -Fc` is in `/var/backups/assessiq/` (script `/etc/cron.daily/assessiq-backup`, repo copy `tools/ops/assessiq-backup.sh`, 14-day retention, plus the weekly Hostinger VPS backup). See the section "Backups" for the restore-drill command and "Disaster recovery" for the full restore. A restore loses everything written after the dump (RPO about 24 h). It needs the `.env` secrets (including `ASSESSIQ_MASTER_KEY`) from the password manager of the owner.

**Staging: NOT built.** A second compose project (`docker compose -p assessiq-staging ...`) is not purely additive on this shared VPS. The evidence comes from `infra/docker-compose.yml` and the Caddyfile:

- Every service has a hard-coded `container_name` (`assessiq-postgres`, `assessiq-api`, ...). A second project would collide with production on start, or you would have to change every name.
- Host ports `9091`, `9092` and `9093` are fixed, and Caddy routes to them. Staging needs three new ports, a new Caddy host block, a new Cloudflare record and an origin cert. A new hostname is new shared-edge surface (the Caddyfile belongs to ti-platform).
- The network is named `assessiq-net`. The volumes are `assessiq_pgdata` and `assessiq_redis` under the compose project name, and `./postgres/init` and `../secrets` are shared paths. These need care, so that nobody touches production data.
- The api runs Claude Code under the Max login of the owner. A staging api would share that quota and OAuth session.
- Staging would need its own scrubbed database, its own `.env` and its own AOP and origin-verify setup.

If someone wants staging later, build it off-box (a local compose run that uses `tools/test-support/apply-all-migrations.ts`) and not on the shared VPS. Until then, the pre-deploy gates (section "Pre-deploy lint gates") plus a fast rollback are the safety net.

**NOT included:** down migrations, blue/green, automated rollback.

## Rotate the master key (E8)

**Goal:** replace `ASSESSIQ_MASTER_KEY` and re-encrypt the stored secrets.

**Owner go-ahead required before you run this on prod.** Nothing in this section ran against production. The team proved it only on a throwaway test database (`modules/01-auth/src/__tests__/master-key-rotation.test.ts`).

**What it protects.** Env var: `ASSESSIQ_MASTER_KEY` (base64, 32 bytes, validated in `modules/00-core/src/config.ts`). Cipher: AES-256-GCM, 12-byte nonce. Encrypted columns (the complete list; `TARGETS` in `tools/rotate-master-key.ts` must match):

| Table.column | Layout | Code |
|---|---|---|
| `user_credentials.totp_secret_enc` (BYTEA) | nonce, ciphertext, tag | `modules/01-auth/src/totp.ts`, `crypto-util.ts` |
| `embed_secrets.secret_enc` (BYTEA) | nonce, ciphertext, tag | `modules/01-auth/src/embed-jwt.ts` |
| `webhook_endpoints.secret_enc` (BYTEA) | iv, tag, ciphertext | `modules/13-notifications/src/webhooks/crypto.ts` |
| `tenant_settings.webhook_secret` (TEXT, base64) | nonce, ciphertext, tag | `modules/12-embed-sdk/src/webhook-secret-service.ts` (write only) |

A migration comment describes `tenants.smtp_config.password_enc`, but no code writes or reads it. Recovery codes are hashes, not encrypted. The older "Secret rotation procedure" row lists some column names that do not exist. This section is the correct list.

**Dual-key support.** Optional `ASSESSIQ_MASTER_KEY_PREVIOUS`. Decrypt tries the current key, then the previous key. Encrypt always uses the current key. With the variable unset, the behaviour is unchanged. A wrong key cannot return wrong plaintext, because GCM authentication fails.

**Procedure**

1. Take a fresh backup and confirm it: run `/etc/cron.daily/assessiq-backup` as root, then run `tail -1 /var/log/assessiq/backup.log`.
2. Generate the new key: `openssl rand -base64 32`. Store it in the password manager now. Confirm that the password manager also holds the old key.
3. In `/srv/assessiq/.env`, set `ASSESSIQ_MASTER_KEY_PREVIOUS=<old value>` and `ASSESSIQ_MASTER_KEY=<new value>`. Edit with truncate-write, not `mv`.
4. Make sure that no AI grading run is in flight. Recreate api and worker: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker`. Check `/api/health`. Everything still works, because old rows decrypt through the fallback.
5. Do a dry run (it writes nothing and prints counts only): `docker exec assessiq-api pnpm exec tsx /app/tools/rotate-master-key.ts`. Expect `undecryptable=0` on every line. If it is not zero, stop. The old key value is wrong, or a row is corrupt. Nothing was written.
6. Apply: `docker exec assessiq-api pnpm exec tsx /app/tools/rotate-master-key.ts --apply`. It is safe to run again. Each batch is one transaction under `SET LOCAL ROLE assessiq_system`.
7. Verify: run the dry run again. Expect `would_rotate=0` and `already_new=total` on every line. Suppose any line shows `would_rotate>0`. This means a row was written under the old key while the sweep ran (the pass-2 cursor cannot see rows inserted behind it). Then run `--apply` again and repeat this check. Never do step 8 until every line is zero (codex review 2026-10-02). Then do a TOTP login with an enrolled admin and list the embed secrets.
8. Remove `ASSESSIQ_MASTER_KEY_PREVIOUS` from `.env`. Recreate api and worker again. Repeat the check in step 7.
9. Keep the OLD key offline in the password manager for at least 30 days. Any backup from before the rotation needs the old key to read its encrypted columns (dump retention is 14 days, plus the weekly Hostinger backup). Delete the old key only after every older backup has aged out.

**Rollback during the procedure.** Before step 8, both keys work. Put the old key back as `ASSESSIQ_MASTER_KEY`, set the new key as `ASSESSIQ_MASTER_KEY_PREVIOUS`, recreate, and run `--apply` again to rotate back. To restore a dump from before the rotation, you need the old key.

**Not included:** automatic scheduling, rotation of `SESSION_SECRET` (a different key; a rotation logs everyone out), per-tenant keys.

**Downstream impact:** `modules/00-core/src/config.ts` (new optional var), `modules/01-auth/src/crypto-util.ts` and `modules/13-notifications/src/webhooks/crypto.ts` (decrypt fallback), `.env.example`. If someone adds a new encrypted column, add it to `TARGETS` in `tools/rotate-master-key.ts`. Otherwise the rotation strands the column.

## Rotate a secret

**Goal:** replace a secret on the VPS. This is the older general procedure.

| Secret | Storage | Rotation cadence | Procedure | Downtime |
| --- | --- | --- | --- | --- |
| `pg_password` (postgres superuser) | `/srv/assessiq/secrets/pg_password.txt`, password manager mirror | annual minimum or on-incident | Generate a new value (`openssl rand -base64 32`), run `ALTER USER assessiq PASSWORD '<new>'`, and write the new value to the secret file (an atomic mv inside the secrets dir is fine; these files have no bind-mount inode trap). You do NOT need to restart `assessiq-postgres`, because Postgres re-reads the password on the next auth. | none |
| `assessiq_app_password` / `assessiq_system_password` (RLS roles) | `/srv/assessiq/secrets/assessiq_{app,system}_password.txt`, password manager mirror | annual minimum or on-incident | Use the same `ALTER ROLE` pattern as above. Then update `DATABASE_URL` in `.env`, then run `docker compose restart assessiq-api assessiq-worker`. | brief: in-flight API requests fail during the restart window (~5s) |
| `SESSION_SECRET` | `/srv/assessiq/.env`, password manager mirror | annual minimum or on-incident | Edit `.env`, then run `docker compose restart assessiq-api`. **All active sessions invalidate immediately.** Users sign in again. | session invalidation (no data loss) |
| `ASSESSIQ_MASTER_KEY` | `/srv/assessiq/.env`, **password manager mirror MANDATORY** (loss = unrecoverable encrypted blobs in DB) | annual minimum or on-incident | This is the hard one. Procedure: (a) generate a new key (`openssl rand -base64 32`); (b) write a one-shot re-encryption script that reads each encrypted column (`users.totp_secret_enc`, `oauth_identities.refresh_token_enc`, `tenants.embed_secret_enc`, and so on; the schema enumerates the full list), decrypts with the OLD key, re-encrypts with the NEW key, and writes back inside a single transaction for each row; (c) keep BOTH keys readable during the transition (`ASSESSIQ_MASTER_KEY=<new>`, `ASSESSIQ_MASTER_KEY_PREVIOUS=<old>`; the decrypt path tries new first, then old); (d) once the script confirms 100% migrated, drop `ASSESSIQ_MASTER_KEY_PREVIOUS`. | none if the `00-core` crypto helpers implement the dual-key fallback; brief otherwise |
| `GOOGLE_CLIENT_SECRET` | `/srv/assessiq/.env`, Google Cloud Console mirror | on-incident only (a Google rotation does not invalidate active sessions) | Generate a new client secret in the Google Cloud Console, edit `.env`, then run `docker compose restart assessiq-api`. The old secret stays valid until you delete it in the console. This overlap window protects against a bad rotation. | none |
| Per-tenant `embed_secret` (one for each tenant, encrypted at rest with `ASSESSIQ_MASTER_KEY`) | `tenants.embed_secret_enc` column | on-incident or on-host-app-request | **Invalidate and reissue.** There is no rotation, only re-issuance: generate a new `embed_secret` for each tenant, store it encrypted, and tell the host app out of band. The system immediately rejects old JWTs that the old secret signed. | host-app embed integrations break until they update their JWT-signing secret |

**What changed:** Before, the doc listed the env vars but had no rotation procedure for any of them. The most consequential secret (`ASSESSIQ_MASTER_KEY`) had no documented re-encryption path.

**Why:** Secrets with no documented rotation procedure either do not get rotated (a compliance and security risk) or get rotated badly (an operational outage). `ASSESSIQ_MASTER_KEY` can soft-brick the system if someone rotates it naively without the dual-key fallback.

**Considered and rejected:**

- (a) Build the dual-key fallback into `00-core` immediately. The team recorded it as a Phase 1 hardening item. The `00-core` crypto helpers exist but accept only a single key today. The master-key-rotation row in the table depends on Phase 1 lifting that limit.
- (b) Automate master-key rotation on a calendar. Rejected: rotation is a known-disruptive event that an operator should drive, not cron.

**NOT included:** key escrow or split knowledge for `ASSESSIQ_MASTER_KEY` (Phase 4+ if a tenant requires it), HSM integration, and automatic rotation on a detected compromise.

**Downstream impact:** The failure-mode runbook "ASSESSIQ_MASTER_KEY lost" branches into the worst-case re-enrollment workflow, because the rotation procedure here lays out the controlled path that a loss bypasses. The embed-secret invalidate-and-reissue model means that host apps must accept that their integration is bound to the choice of one tenant for the secret-rotation cadence.

## First-boot bootstrap (`/srv/assessiq/`)

**Goal:** bring up the AssessIQ stack on a new host or a new clone.

Run as a non-root user with Docker group membership.

```bash
# 1. Clone via the deploy key (SSH config stanza must exist at ~/.ssh/config on the VPS)
#    SSH config Host stanza: Host github.com-assessiq → ~/.ssh/github_deploy (read-only deploy key)
#    See § Deploy key above for fingerprint and registration URL.
cd /srv && git clone git@github.com-assessiq:manishjnv/assessIQ.git assessiq && cd assessiq

# 2. Generate secrets
mkdir -p secrets infra/postgres/init
openssl rand -base64 32 > secrets/pg_password.txt
chmod 0600 secrets/pg_password.txt

# 3. Create .env from example, then fill values
cp .env.example .env
chmod 0600 .env
# Generate the two random keys and paste in:
echo "ASSESSIQ_MASTER_KEY=$(openssl rand -base64 32)" >> .env
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
# Edit .env to add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, EMAIL_FROM, etc.
$EDITOR .env

# 4. Cloudflare Origin Cert — generate in CF dashboard, then:
sudo mkdir -p /opt/ti-platform/caddy/ssl
sudo cp ~/assessiq.automateedge.cloud.pem /opt/ti-platform/caddy/ssl/
sudo cp ~/assessiq.automateedge.cloud.key /opt/ti-platform/caddy/ssl/
sudo chmod 0600 /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.key

# 5. Append the AssessIQ Caddyfile block (see "Reverse-proxy plan" in this page)
sudo cp /opt/ti-platform/caddy/Caddyfile \
        /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)
# Append block; validate; reload:
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec ti-platform-caddy-1 caddy reload   --config /etc/caddy/Caddyfile

# 6. Confirm Cloudflare DNS A record (proxied) is set, SSL mode = Full (Strict)
dig +short assessiq.automateedge.cloud  # should return CF anycast IPs

# 7. Boot the AssessIQ stack
docker compose -f infra/docker-compose.yml up -d

# 8. Run migrations
#    tools/migrate.ts requires direct DB access; postgres is on the internal
#    assessiq-net bridge (no host port). Pipe each migration into psql instead:
# WARNING (RV78, 2026-10-03): this loop sorts by path and is WRONG for a fresh database.
# A plain basename order runs 0010 before 020 (users) and fails on an empty database.
# The real order is the grouping in tools/test-support/apply-all-migrations.ts. Use it for a new database.
# Steady-state deploys apply only new files, so they are not affected.
find /srv/assessiq/modules -path '*/migrations/*.sql' | sort | while read f; do
  echo "→ $(basename $f)"
  docker exec -i assessiq-postgres psql -U assessiq -d assessiq \
    -v ON_ERROR_STOP=1 < "$f"
done
echo "Migrations done."
#    Verify:
docker exec assessiq-postgres psql -U assessiq -d assessiq \
  -tAc "SELECT version FROM schema_migrations ORDER BY version;"

# 9. Bootstrap first tenant + admin user
#    No automated seed script exists yet — insert directly via psql.
#    Replace the email with your real Google Workspace admin address.
docker exec assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 -c "
  INSERT INTO tenants (id, slug, name, status)
  VALUES ('00000000-0000-0000-0000-000000000001', 'wipro-soc', 'Wipro SOC', 'active');
  INSERT INTO tenant_settings (tenant_id)
  VALUES ('00000000-0000-0000-0000-000000000001');
  INSERT INTO users (tenant_id, email, name, role, status)
  VALUES ('00000000-0000-0000-0000-000000000001',
          '<admin@your-google-workspace>', '<Admin Name>', 'admin', 'active');
"
```

After bootstrap, sign in at `https://assessiq.automateedge.cloud/admin/login` and complete the TOTP enrollment. The platform is live.

## Backups — `/etc/cron.daily/assessiq-backup`

**Goal:** keep the nightly dump and check that it ran.

> **Status (2026-10-01): INSTALLED and verified.** Until this date, the cron described here existed only in this doc. The VPS had no backup job, no `/var/backups/assessiq` and no rclone (see RCA 2026-10-01 "Documented DB backups were never installed").

**What runs (the live copy on the VPS is the source of truth. A byte-identical copy is in the repo at `tools/ops/assessiq-backup.sh`. Redeploy it with `scp tools/ops/assessiq-backup.sh assessiq-vps:/etc/cron.daily/assessiq-backup`, then `chmod 755`. The script has no secrets inside; it reads `SMTP_URL` from `/srv/assessiq/.env` at runtime):**

- **Schedule and dump:** `/etc/cron.daily/assessiq-backup` runs as root once a day (run-parts, about 06:25 server time). It runs `docker exec assessiq-postgres pg_dump -U assessiq -d assessiq -Fc` to write `/var/backups/assessiq/assessiq-<UTC-ts>.dump`. The custom format is already compressed, so there is no gzip. The directory is 0700 and each file is 0600.
- **Integrity check:** the new archive must pass `pg_restore -l` before it replaces the temp file.
- **Retention:** 14 days. The script deletes only `assessiq-*.dump` files inside that directory.
- **Log:** one line per run in `/var/log/assessiq/backup.log`, `OK <file> <bytes>` or `FAIL rc=… line=…`.
- **Failure alert:** an `ERR` trap emails `connect@assessiq.in` (which forwards to the Gmail of the owner). It uses `curl` with the own `SMTP_URL` of the app from `/srv/assessiq/.env` (Brevo), with no extra account. The team tested the alert path on 2026-10-01, and it delivered.
- **Offsite:** the **Hostinger weekly VPS backup** that the owner enabled, which captures `/var/backups/assessiq`. The worst-case data loss is about 1 day if the disk survives, and up to about 7 days if the whole VPS is lost.
- **Prompt skills (added 2026-10-01 b):** each run also tars `/srv/assessiq/prompts/skills` to `prompts-skills-<ts>.tgz` (14-day retention). The prompts are gitignored, so this tarball plus the host copy are the only copies besides the laptop of the owner. If the folder is missing, the run emails an alert.
- **Known ceiling (`ponytail`):** if the cron daemon itself stops, nothing alerts. Add an external dead-man ping (healthchecks.io) if that matters. The team did not adopt the rclone/R2 offsite (the original design below). Add it if the RPO must be under 7 days for a VPS loss.

**Restore drill, 2026-10-01: PASSED.**
- **Setup:** a throwaway `assessiq-restore-drill` container (`postgres:16-alpine`, `--network none`), `pg_restore --no-owner --no-privileges`.
- **Result:** 0 errors. Row counts matched live exactly: tenants 6, users 11, questions 337, attempts 5, gradings 8, audit_log 941.
- **Cleanup:** the team removed the container afterwards.

Drill command pattern (read-only against the live DB; the drill creates and removes only the drill container):

```bash
IMG=$(docker inspect -f '{{.Config.Image}}' assessiq-postgres)
docker run -d --rm --name assessiq-restore-drill --network none \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=assessiq -e POSTGRES_DB=assessiq "$IMG"
DUMP=$(ls -t /var/backups/assessiq/assessiq-*.dump | head -1)
docker exec -i assessiq-restore-drill pg_restore -U assessiq -d assessiq --no-owner --no-privileges < "$DUMP"
# compare counts of tenants/users/questions/attempts/gradings/audit_log vs assessiq-postgres, then:
docker rm -f assessiq-restore-drill
```

**Secrets are not in the dump.** Keep `MASTER_KEY` and the rest of `/srv/assessiq/.env` separately (the password manager of the owner). Without `MASTER_KEY`, you cannot read the encrypted columns after a restore.

<details><summary>Original (never-installed) design, kept for reference</summary>

```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/var/backups/assessiq

mkdir -p $DEST
docker compose -f /srv/assessiq/infra/docker-compose.yml exec -T assessiq-postgres \
  pg_dump -U assessiq -d assessiq -Fc | gzip > $DEST/assessiq-$TS.dump.gz

# Retention: 14 daily, 8 weekly (kept by hand)
find $DEST -name 'assessiq-*.dump.gz' -mtime +14 -delete

# Offsite (configure rclone remote separately)
rclone copy $DEST/assessiq-$TS.dump.gz remote:assessiq-backups/ || true
```

</details>

**Restore drill (run monthly):** use the drill pattern above. Log the result in `docs/RCA_LOG.md` if anything wobbles.

> See § Disaster recovery below for these items:
>
> - The full backup-contents inventory (including which artefacts the team intentionally does NOT back up).
> - The fresh-VPS restore procedure with expected outputs.
> - The failure-mode runbooks.
> - The recovery-readiness monitoring thresholds.
> - The secret-rotation procedure.
>
> The cron snippet above is the producer. The DR section is the consumer.

## Install the backup check (RV73, owner step, not done)

**Goal:** add the dead-man check for the nightly backup.

Files: `tools/ops/assessiq-backup-check.sh` (dead-man check; self-test with 11 cases), `infra/systemd/assessiq-backup-check.service`, `infra/systemd/assessiq-backup-check.timer`. The check reports STALE when the newest dump is old or has a future mtime. It needs a heartbeat service account (the owner chooses it).

1. Copy the script to `/usr/local/sbin/assessiq-backup-check.sh` (owner `root:root`, mode 0755).
2. Put the heartbeat URL in an `EnvironmentFile` (`/etc/assessiq/backup-check.env`, owner `root:root`, mode 0600).
3. Option A, cron: add one line to `/etc/cron.d/assessiq-backup-check` that runs the script after the nightly backup.
4. Option B, systemd: copy the two unit files to `/etc/systemd/system/`, run `systemctl daemon-reload`, then run `systemctl enable --now assessiq-backup-check.timer`. Touch only `assessiq-*` units.
5. Run the script once by hand and check that it prints OK.

Before step 1, do the enumerate-first checks of project rule 8.

## Restore from backup and disaster recovery

**Goal:** rebuild the system on a fresh VPS from the offsite dump.

This section pins the procedure to restore AssessIQ after a catastrophic failure of the Hostinger VPS, the Postgres data volume, or the broader shared-infra stack. It covers the procedure only. These items are explicitly out of scope here, and the team tracks them separately: the setup of the offsite target (rclone + B2 bucket), the wiring of monitoring agents, and a `dr-drill.sh` automation script. This section consumes the `## Backups` cron, the secret files at `/srv/assessiq/secrets/`, and the additive Caddy block at `/opt/ti-platform/caddy/Caddyfile`. It produces the operational confidence that a known-bad event has a known-good recovery path inside the documented RTO.

### Recovery objectives (RTO / RPO)

| Objective | Target | Phase |
| --- | --- | --- |
| **RTO** (recovery time objective) | **1 hour** from incident declaration to service restored on a fresh VPS, assuming the offsite backups are intact and reachable | Phase 1 |
| **RPO** (recovery point objective) | **24 hours** of data loss tolerance; the daily logical `pg_dump` is the only persistence point | Phase 1 |
| RPO upgrade path | Sub-hour, through WAL streaming to offsite (for example wal-g + B2) or a managed Postgres with PITR | Phase 4+ |

**What changed:** Before, the deployment doc had no explicit RTO/RPO, only a bare cron snippet and a one-line drill reminder.

**Why:** Without pinned objectives, the team cannot tell whether the existing `pg_dump|gzip` pipeline is fit for purpose or silently under-spec. Pinned 1h/24h objectives force every future infra decision (cron cadence, offsite frequency, alert thresholds) to be answerable against a target.

**Considered and rejected:**

- (a) WAL streaming and sub-hour RPO from day one. Rejected: the operational complexity (wal-g daemon, retention pruning, disaster-restore PITR drill) is disproportionate to a Phase 1 SOC pack with a single-digit-tenant load. The team documents the path as Phase 4+, so the upgrade is trivial when it is earned.
- (b) RTO < 1h through a hot standby. Rejected for the same Phase-1-cost reason. A hot standby on the same shared VPS also adds zero failure-domain coverage.

**NOT included:** zero-RTO failover, multi-region replication, and any guarantee for the broader shared infra (Caddy, ti-platform stack). Those failure modes have their own runbooks below.

**Downstream impact:** The 30-hour backup-freshness alert in § Recovery readiness derives from this RPO (one missed nightly cron + a 6h grace). The secret rotation cadence in § Secret rotation procedure can be slower than the RPO, because secrets in the password manager are not bound by the data-loss window.

### Backup inventory

This table shows what exists, where it lives, its retention and (importantly) what the team intentionally does NOT back up.

| Artefact | Location | Retention | Backed up? | Notes |
| --- | --- | --- | --- | --- |
| Postgres logical dump | `/var/backups/assessiq/assessiq-<UTC-ts>.dump.gz` | **14 daily on disk**, **8 weekly archived by hand** | ✅ produced by `/etc/cron.daily/assessiq-backup` | Format: `pg_dump -Fc` (custom), gzip-compressed. Restore with `pg_restore`, NOT `psql`. |
| Postgres dump (offsite copy) | `remote:assessiq-backups-prod/assessiq-<UTC-ts>.dump.gz` (rclone target; placeholder bucket name; the user wires the actual B2 / S3 credentials separately) | Match the local cadence; the offsite-only retention is TBD by storage cost | ✅ pushed by the rclone line at the end of the cron | The `\|\| true` in the cron means that an offsite-push failure does not fail the local backup. The § Recovery readiness "offsite sync freshness" alert must catch a missed offsite push, not the cron exit code. |
| `/srv/assessiq/.env` | VPS only | n/a — operational secrets | ❌ **never offsite** | Regenerate it from the password manager + the `ASSESSIQ_MASTER_KEY` rotation procedure. See § Secret rotation procedure. |
| `/srv/assessiq/secrets/*.txt` (pg_password, assessiq_app_password, assessiq_system_password) | VPS only | n/a | ❌ **never offsite** | Regenerate them on restore with `openssl rand -base64 32`. The freshly restored Postgres has the OLD passwords baked into its catalog (from the dump). The restore procedure includes an `ALTER ROLE` step to align the database with the new secret files. |
| Redis (BullMQ queues, sessions, rate-limit counters) | `assessiq_redis` Docker volume | AOF + `--save 60 1000` | ❌ **intentionally not backed up** | You can recover all three Redis purposes after a loss. Sessions invalidate (users sign in again through Google SSO). BullMQ queues drop (the admin triggers any failed grading jobs again from the dashboard once it ships). Rate-limit counters reset (a brief permissive window is acceptable). A Redis backup would buy nothing that AssessIQ cares about, and it would complicate a parallel restore. |
| CF Origin Cert (`/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`) | VPS only | 15-year validity | ❌ **regenerate from CF dashboard** | The manual procedure is in `## Reverse-proxy plan` § Apply procedure step 1. **A re-paste exposes RCA `2026-04-30 — CF Origin Cert paste artifact` again.** Apply the `sed` cleanup on the new cert too. The 15-year horizon means that rotation is rare. The RTO does not bind the cert. |
| Caddy block (`/opt/ti-platform/caddy/Caddyfile` AssessIQ section) | Shared file with timestamped `.bak.<UTC-ts>` siblings | Per-edit backups, no auto-pruning | ⚠️ implicit through the `cp .bak.` step in § Reverse-proxy plan and § swap-back; not a true backup | A fresh-VPS rebuild copies the AssessIQ block from this doc into a fresh ti-platform Caddyfile. The doc IS the backup of the intent of the block. |
| Application code | `manishjnv/assessIQ` GitHub | git history | ✅ implicit through the origin remote | Restore with `git clone`. No separate backup is needed. |
| AI prompt skills (`~/.claude/skills/grade-{anchors,band,escalate}/SKILL.md`) on VPS | VPS only | n/a Phase 1 | ❌ deferred to Phase 2 | Phase 1 grading runs as the Claude Code CLI under the admin Max OAuth. The author edits the skills on the VPS per `CLAUDE.md` rule #6. Their sha256 lands on every grading row. Phase 2 moves them into the repo at `modules/07-ai-grading/prompts/` with API-key auth. Git then backs them up automatically. |

**What changed:** The original `## Backups` section listed only the Postgres dump cadence and the offsite line. It did not enumerate Redis, the CF cert, the env file, the secrets or the Caddy block. It did not flag which artefacts the team intentionally does NOT back up.

**Why:** Confusion at restore time is the #1 cause of blown RTOs. The operator needs an unambiguous reference that answers one question: "is this thing on the list, and if not, what do I do instead?". A guess based on what the operator happened to remember is not enough.

**Considered and rejected:** A Redis backup "for completeness". Rejected: it complicates a parallel restore, it doubles the offsite egress, and AssessIQ has no Redis-only state worth recovering.

**NOT included:** An offsite copy of the `.env` (operational secret hygiene; the password manager is the source of truth). Backups of the broader shared VPS state (out of scope per `CLAUDE.md` rule #8; that is the responsibility of the ti-platform owner).

**Downstream impact:** The restore procedure below assumes that exactly the artefacts in this table exist or that you can regenerate them. The failure-mode runbooks branch on whether a failure mode loses something that is on the table or off it.

### Restore procedure (fresh-VPS rebuild)

This procedure targets an RTO of 1h. Run it as root (or as a sudoer with passwordless sudo) on the new VPS. Every step respects `CLAUDE.md` rule #8: additive only, AssessIQ-namespaced, and never touching non-`assessiq-*` artefacts on the shared box. The Caddy-block-restore step (#6) uses the established AssessIQ-block exception in the same rule.

```bash
# 1. Preflight: ensure Docker + git + openssl are available; create the AssessIQ namespace.
which docker git openssl rclone || { echo "install missing tooling and re-run" >&2; exit 1; }
mkdir -p /srv/assessiq/{infra/postgres/init,migrations,secrets} \
         /var/backups/assessiq /var/log/assessiq
chmod 0700 /srv/assessiq/secrets

# 2. Clone the repo at the production SHA (or main if PITR is acceptable).
cd /srv && git clone git@github.com:manishjnv/assessIQ.git assessiq && cd assessiq
git checkout <SHA-from-last-known-good-deploy>      # else: stay on origin/main

# 3. Generate fresh secrets (the OLD ones are gone with the old VPS — that's the whole point).
openssl rand -base64 32 | tr -d '\n' > secrets/pg_password.txt
openssl rand -base64 32 | tr -d '\n' > secrets/assessiq_app_password.txt
openssl rand -base64 32 | tr -d '\n' > secrets/assessiq_system_password.txt
chmod 0600 secrets/*.txt
# Re-create .env from password-manager values (Google OAuth client, SMTP, ASSESSIQ_MASTER_KEY,
# SESSION_SECRET). ASSESSIQ_MASTER_KEY MUST match the one that encrypted the TOTP/embed secrets
# in the dump — see § Secret rotation procedure. If it doesn't, TOTP and embed-secret
# decryption will silently fail at first auth/embed attempt.
$EDITOR .env
chmod 0600 .env

# 4. Restore Caddy block on the EXISTING ti-platform-caddy-1 (additive — never a new Caddy
# instance on this box per CLAUDE.md rule #8; the block exception is established).
sudo cp /opt/ti-platform/caddy/Caddyfile \
        /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)
# Append the AssessIQ block from § Reverse-proxy plan in this page using `cat new >> Caddyfile`
# (truncate-WRITE on bind-mount-inode applies to single-file mounts; ti-platform's Caddyfile
# is a single-file bind mount per the existing § swap-back note — `cat ... > full` for a full
# rewrite, `>>` for an append). For first-time restore the Caddyfile already exists with the
# other apps' blocks; append. Validate before reload:
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec ti-platform-caddy-1 caddy reload   --config /etc/caddy/Caddyfile

# 5. Re-place the CF Origin Cert (re-paste from CF dashboard or re-issue if compromised).
# CRITICAL: apply the paste-artifact cleanup BEFORE openssl verify or any Caddy operation
# (RCA 2026-04-30):
sudo sed -i 's/\r$//; s/^[[:space:]]*//' \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.key
openssl x509 -noout -subject -in /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem
openssl rsa  -noout -modulus -in /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.key | openssl md5
openssl x509 -noout -modulus -in /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem | openssl md5
# Last two MD5s MUST match. If not, the cert/key are mismatched — do not proceed.

# 6. Bring up data-plane services first; wait for healthy.
docker compose -f infra/docker-compose.yml up -d assessiq-postgres assessiq-redis
docker compose -f infra/docker-compose.yml ps   # both healthy within ~14s

# 7. Pull the most recent dump from offsite (or use a local copy if disaster was scoped).
rclone copy remote:assessiq-backups-prod/assessiq-LATEST.dump.gz /tmp/   # or specific UTC-ts
ls -lh /tmp/assessiq-LATEST.dump.gz   # sanity-check size against expected production size

# 8. Restore via pg_restore (NOT psql — pg_dump -Fc produces a custom-format archive).
gunzip -c /tmp/assessiq-LATEST.dump.gz | \
  docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
    pg_restore -U assessiq -d assessiq --clean --if-exists --no-owner --no-acl

# 9. Re-align role passwords with the new secret files (the dump baked the OLD passwords
# into pg_authid; the freshly-generated secret files have NEW ones).
APP_PW=$(cat secrets/assessiq_app_password.txt)
SYS_PW=$(cat secrets/assessiq_system_password.txt)
docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
  psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE assessiq_app PASSWORD '$APP_PW'; ALTER ROLE assessiq_system PASSWORD '$SYS_PW';"

# 10. Apply any migrations newer than the dump's snapshot (rare — flag if it happens, since
# the dump should be from a healthy production state). If tools/migrate.ts has shipped:
docker compose -f infra/docker-compose.yml exec assessiq-api npm run db:migrate
# Phase 0/early-Phase 1: ad-hoc apply per G0.B-2 02-tenancy procedure.

# 11. Bring up the application plane.
docker compose -f infra/docker-compose.yml up -d assessiq-api assessiq-worker assessiq-frontend
docker compose -f infra/docker-compose.yml ps   # all healthy within ~30s

# 12. Smoke verification.
curl -sS https://assessiq.automateedge.cloud/api/health | jq .   # expect {"status":"ok",...}
docker compose -f infra/docker-compose.yml exec assessiq-postgres \
  psql -U assessiq -d assessiq -c "SELECT count(*) FROM tenants; SELECT count(*) FROM users;"
# Numbers should match the pre-incident snapshot (record this in your runbook log).
# Verify a known tenant + admin user exists; confirm Google SSO callback works on first login.
```

If the IP changed, update the Cloudflare A record `assessiq.automateedge.cloud` → new VPS IPv4 BEFORE step 4. The record is proxied, and the CF DNS propagation through the CF edge takes < 30 s for proxied records. The DNS update is the only step that touches state outside the VPS.

**What changed:** The earlier deployment doc had no fresh-VPS restore procedure, only the cron snippet and a one-line monthly-drill reminder.

**Why:** Without an end-to-end procedure with commands, expected outputs and the order in which they run, the operator under stress reaches for guesses. The 1h RTO is unattainable without it.

**Considered and rejected:**

- (a) Restoring with `psql` from a plain SQL dump. Rejected: the cron uses `pg_dump -Fc` (custom format), and `psql` cannot read it. `pg_restore` is non-negotiable.
- (b) Bringing up `assessiq-api` before the role-password realignment. Rejected: the API connects as `assessiq_app` with the new password from the secret file, but the freshly restored `pg_authid` still has the old password baked in. The API would crash-loop until `ALTER ROLE` ran.
- (c) Standing up a brand-new Caddy instance on the new VPS. Rejected per `CLAUDE.md` rule #8. The additive-only constraint means that we restore the AssessIQ block on the existing `ti-platform-caddy-1`.

**NOT included:** Restore from a partial or corrupted dump (a separate diagnostic procedure that uses `pg_restore --list` to identify recoverable objects). Restore of the BullMQ queue contents (intentionally not backed up; the admin triggers any failed grading jobs again). Restore of the prior `.env` byte for byte (the procedure recreates only the values that you can regenerate from the password manager + the `ASSESSIQ_MASTER_KEY` source of truth).

**Downstream impact:** The § Recovery readiness "restore drill staleness" alert exists because the only way to know that this procedure still works is to run it monthly. The § Failure modes "VPS dead" branches into this procedure as its concrete remediation.

### Restore drill cadence

The user runs the drill **monthly**, on a side container (NOT the production stack), against a temporary database `assessiq_restore_test`:

```bash
# On the production VPS (or any host with the dump file in reach):
gunzip -c /var/backups/assessiq/assessiq-<recent>.dump.gz | \
  docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
    psql -U assessiq -d postgres -c "DROP DATABASE IF EXISTS assessiq_restore_test;"
docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
  psql -U assessiq -d postgres -c "CREATE DATABASE assessiq_restore_test;"
gunzip -c /var/backups/assessiq/assessiq-<recent>.dump.gz | \
  docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
    pg_restore -U assessiq -d assessiq_restore_test --no-owner --no-acl
docker compose -f infra/docker-compose.yml exec assessiq-postgres \
  psql -U assessiq -d assessiq_restore_test -c \
    "SELECT 'tenants', count(*) FROM tenants UNION ALL
     SELECT 'users', count(*) FROM users UNION ALL
     SELECT 'sessions', count(*) FROM pg_stat_activity WHERE datname='assessiq_restore_test';"
# Compare row counts against the production stack snapshot taken at the same UTC timestamp.
docker compose -f infra/docker-compose.yml exec -T assessiq-postgres \
  psql -U assessiq -d postgres -c "DROP DATABASE assessiq_restore_test;"
# Update the drill marker (used by § Recovery readiness):
date -u +%Y-%m-%dT%H:%M:%SZ > /var/backups/assessiq/.last-drill
```

Append the drill outcome to `docs/RCA_LOG.md` ONLY if anything wobbled (row counts mismatched, the restore errored, an unexpected migration was missing, or the offsite copy was unreadable). The marker file records successful drills, not the RCA log. The RCA log is for incidents, not for routine confirmations.

**What changed:** Before, the doc had a single-line "run monthly" reminder with no concrete procedure.

**Why:** An unverified backup is hypothetical, and the drill is the verification. The side-container approach (separate database name, drop after verify) leaves the production stack untouched. The drill never risks production.

**Considered and rejected:**

- (a) Running the drill against a separate Postgres instance. Rejected as overhead: the production Postgres can host a temporary database without side effects during the brief verification window.
- (b) Automating the drill with a `dr-drill.sh` script. Out of scope for this session per the pin of the user. The procedure-first approach lets the operator run it interactively while the operator learns the failure surface. A future session can wrap it.

**NOT included:** Schema-diff verification against migration files (Phase 2+, when `tools/migrate.ts` ships with a tracking table). A full app-level smoke against the restored database (the production stack stays in front of the production database; a temporary flip would defeat the side-container isolation).

**Downstream impact:** The § Recovery readiness "restore drill staleness" alert reads the `.last-drill` marker file. Without the marker, there is no signal to alert on.

### Failure modes & runbooks

| Failure mode | Recovery | Owner |
| --- | --- | --- |
| **Postgres data corruption / volume loss** (most common: disk failure, accidental `DROP`, bad migration) | § Restore procedure above. RTO 1h, RPO 24h. If only the volume is lost (the VPS is otherwise healthy), skip steps 1, 4-5 and 11 and restore Postgres in place. | AssessIQ |
| **Redis loss** (volume corruption, OOM kill, container removal) | Expected and tolerated. Sessions invalidate (users sign in again through Google SSO + TOTP). BullMQ queues drop (the admin triggers any failed grading jobs again from the admin dashboard once it ships in Phase 2; Phase 1 has no async grading queue, so the failure surface is just sessions). Rate-limit counters reset. **No restore action needed.** `docker compose up -d assessiq-redis` brings it back empty. | AssessIQ |
| **Caddy down / shared edge unhealthy** | All apps on the box return 5xx publicly, not only AssessIQ. AssessIQ has no recourse alone, because the Caddyfile and the `ti-platform-caddy-1` container belong to ti-platform. **Escalate to the ti-platform owner.** Do NOT attempt to start a parallel Caddy on host:80/:443. It will fail to bind. Even if it succeeded, it would steal traffic from the other apps, in violation of `CLAUDE.md` rule #8. | ti-platform (escalation only) |
| **VPS dead** (host failure, full disk, irrecoverable OS state) | Create a fresh Hostinger VPS in the same region. Install Docker + git + openssl + rclone. Then run the § Restore procedure end to end. Update the Cloudflare A record `assessiq.automateedge.cloud` → new VPS IPv4 (proxied; the DNS propagation through the CF edge takes < 30s). Re-paste the CF Origin Cert and apply the **`sed` paste-artifact cleanup** again per RCA `2026-04-30`. The other apps on the original box (ti-platform, accessbridge, roadmap) are out of scope. Their owners restore their own stacks. AssessIQ is the first restore on the fresh box only if AssessIQ owns the box. | AssessIQ (own stack); other-app owners (their stacks) |
| **Cloudflare Origin Cert expired or compromised** | Generate a new cert in the CF dashboard (Zero Trust → Origin Server → Create Certificate, RSA 2048, 15-year). Place it at `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`, **apply the `sed` paste-artifact cleanup**, verify with `openssl x509 -noout -subject` and the modulus-MD5 cert↔key match, then run `caddy validate` + `caddy reload`. The 15-year horizon means that this is rare. A compromised cert (leaked key) requires immediate rotation regardless of expiry. | AssessIQ |
| **`ASSESSIQ_MASTER_KEY` lost** (env file corrupted, password manager record lost, no rotation log) | **Worst case:** the TOTP secrets, embed secrets, recovery codes and webhook secrets in the database are unrecoverable encrypted blobs. The restore proceeds, but: (a) all admin users must enroll TOTP again on the next login, (b) all per-tenant embed secrets must be re-issued (host-app integrations break until then), (c) all recovery codes regenerate, (d) all webhook secrets are re-issued (callers receive a new signing secret). This is the strongest motivation for the password-manager discipline below. | AssessIQ + tenant admins (re-enrollment) |
| **`SESSION_SECRET` lost** | All active sessions invalidate, and users sign in again. No data loss. | AssessIQ |

**What changed:** Before, the doc had no failure-mode taxonomy at all. Every incident was reasoned from first principles under stress.

**Why:** The operator under stress needs to find an answer in seconds for a question such as "Redis crashed, what now?". The table is a flat lookup that prevents the wrong action. An example of a wrong action is "restore Redis from backup" when there is no Redis backup and the right action is to do nothing.

**Considered and rejected:** A fully automated failover for any of these modes. Rejected per the Phase-1-cost reasoning above. Manual escalation with a clear runbook is the right rigor for the current load.

**NOT included:**

- Runbooks for failure modes inside the broader shared VPS that AssessIQ does not own. The Caddy runbook is escalation-only, and the actual fix lives in the docs of ti-platform.
- Runbooks for Anthropic API or Claude Code CLI failures. Phase 1 grading is a sync action that an admin clicks. If Claude Code fails, the admin sees the error and retries, and no data integrity is at risk.

**Downstream impact:** The "VPS dead" branch consumes the entire § Restore procedure. The `ASSESSIQ_MASTER_KEY` row is the most important argument for the rotation-and-storage discipline in § Secret rotation procedure.

### Recovery readiness monitoring

This is a **subsection of § Monitoring**, not a duplicate. The § Monitoring table above watches the running stack (HTTP 5xx rate, p95 latency, Postgres connections, Redis memory, grading job age, disk free, TLS expiry, CF origin pull errors). This subsection watches the **backup pipeline itself**. Its signals answer the question "if we needed to restore right now, could we?".

| Signal | Where | Alert if |
| --- | --- | --- |
| Backup freshness (local) | `find /var/backups/assessiq -name 'assessiq-*.dump.gz' -newer <30h-ago>` | no file newer than **30 hours** (one missed nightly cron + a 6h grace) |
| Offsite sync freshness | `rclone log` mtime + last-success grep, for example `tail /var/log/assessiq/rclone.log \| grep -E 'Transferred:.+OK'` | no successful push in **30 hours** (this matches the local cadence; the `\|\| true` in the cron means that a silent failure here is the only signal) |
| Restore drill staleness | `mtime` of `/var/backups/assessiq/.last-drill` | older than **35 days** (5 days of grace beyond the monthly cadence) |
| Dump file size delta | `stat -c %s` of the latest dump against the prior dump | **> 10% shrink** (data loss or a botched migration) **or > 30% growth** (a runaway log table). Both warrant an investigation, but neither is a hard alert |

**What changed:** The existing § Monitoring table watches the live stack, but it had no signals on the backup pipeline. A silent backup failure could go undetected indefinitely, until a real disaster shows that there is nothing to restore from. Examples are a cron exit 0 from `|| true` on an rclone error, or a full disk that prevents the dump from being created in the first place.

**Why:** A backup pipeline that you do not watch is a backup pipeline that has failed. The freshness alerts are the cheapest possible signal that catches the most common failure modes.

**Considered and rejected:**

- (a) A more sophisticated "test-restore-into-temp-db nightly" check. Rejected: the monthly drill already covers correctness verification, and a nightly check would burn IO without proportional confidence.
- (b) Shipping the alerts through a separate alerting stack. Rejected: v1 piggybacks on whatever ti-platform exposes (per the closing note of the existing § Monitoring). The right time to choose a delivery channel is when the user wires the alerts.

**NOT included:** Alerting destinations (Slack, email or PagerDuty; the operator chooses), credential setup for the alerting agent, and the agent itself.

**Downstream impact:** These alerts are the only feedback loop on the backup cron and the drill cadence. Without them, the discipline of "run the drill monthly" relies on volunteers only.

## Monitoring

| Signal | Where | Alert if |
| --- | --- | --- |
| HTTP 5xx rate | Caddy access log → log shipper | > 1% over 5 min |
| API p95 latency | structured logs (pino) | > 500ms over 5 min |
| Postgres connections | `pg_stat_activity` | > 80% of max |
| Redis memory | `INFO memory` | > 80% of maxmemory |
| Grading job age | `grading_jobs` query | oldest queued > 10 min (Phase 2+) |
| **Worker queue depth** | `GET /api/admin/worker/stats` (admin auth, 5s TTL cache) — see [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md) and [docs/11-observability.md § 13](11-observability.md) | `counts.waiting > 50` **OR** `counts.failed > 10`, sustained over 10 min. Both indicate that the BullMQ scheduler cannot drain (Redis stall, Postgres saturation, downstream service exhaustion). Phase 1 has a single-replica worker on a 60s/30s cadence. A sustained depth > 50 is well outside the steady state, where both queues should be empty between ticks. |
| **Worker permanent failures** | `worker.log` — `jq 'select(.msg == "worker.job.failed.permanent")' /var/log/assessiq/worker.log` | any line in the last 30 min. Every entry means that a job exhausted its 5 retries (per [JOB_RETRY_POLICY](../apps/api/src/worker.ts)). Investigate through `GET /api/admin/worker/failed` for the redacted payload + stack tail. After you fix the root cause, recover manually with `POST /api/admin/worker/failed/:id/retry`. |
| Disk free | `df -h /` | < 20% on the volume holding `assessiq_pgdata` |
| TLS expiry | `openssl s_client -showcerts` against the origin | < 60 days remaining (the CF Origin Cert is 15y, but also watch the CF edge cert) |
| CF Origin pull errors | Cloudflare dashboard → Analytics | sustained 5xx from origin |

For v1, piggyback on whatever ti-platform already exposes (likely Prometheus + Grafana on this box already; confirm before you add a duplicate stack).

> See § Disaster recovery → § Recovery readiness for the additional freshness alerts that watch the backup pipeline itself (backup file age, offsite sync staleness, restore-drill recency). These signals come from filesystem mtimes, the rclone log and a drill marker file, not from the runtime stack. So they live in the DR section and not in this table.

## Check the readiness probe `GET /api/ready` (RW-9)

`GET /api/ready` answers whether the API can run AI evaluation now. It needs no login.

- **Checks.** Three checks run in parallel, each with a 5 s timeout: `db` (`SELECT 1`), `redis` (`PING`), `claude` (`claude --version`, no shell).
- **Response.** `{ "status": "ready" | "not_ready", "checks": { "db": bool, "redis": bool, "claude": bool } }`. The status is 200 when all checks pass and 503 when one fails. The body holds no versions and no error text.
- **Cache.** The `db` and `redis` results are cached for 5 s. The `claude` result is cached for 60 s. Concurrent requests share one run. A caller cannot start more than one process each minute.
- **Why no login.** The body holds only booleans, and the process cost is capped by the cache. A monitor can call it without a secret.
- **Use.** Point an uptime monitor at it next to `/api/health`. `/api/health` stays a pure liveness check. The platform evaluation page shows the result as a chip.

## Diagnostics — generation_attempts inspection

Use inspect-attempt to show the full diagnostic state of a generation_attempts row. Use it when a smoke run exits non-zero without a visible root cause (for example, log_analysis and scenario chunks silently fail with exit-1):

```bash
docker exec -w /app/modules/07-ai-grading assessiq-api \
  pnpm exec tsx /app/modules/07-ai-grading/eval/cli-typed.ts inspect-attempt \
  --attempt-id 019e0deb-4dcf-70b1-83fe-8c88e20b7b62 \
  --show-stderr --show-questions
```

Or use the local wrapper (it requires SSH access to ssessiq-vps):

```bash
bash tools/inspect-attempt.sh 019e0deb-4dcf-70b1-83fe-8c88e20b7b62
```

The --show-stderr flag prints the stderr_tail column, truncated to 1024 bytes. This is the primary signal to diagnose chunk-level subprocess failures that are not otherwise visible. The --show-questions flag prints the contentKeys and knowledgeBaseSourceIds of each inserted question, which is useful to verify the MCP gate output. The command is read-only. It exits 0 on success and 2 on attempt-not-found or DB error.

## Operational hygiene

Recurring ops sweeps keep the `questions` and `generation_attempts` tables clean between smoke campaigns and deploys. See `tools/README.md` for the full catalog, including the argument reference and example invocations.
clean between smoke campaigns and deploys. See `tools/README.md` for the
full catalog, including argument reference and example invocations.

Key scripts:

- **`tools/cleanup-stale-drafts.ts`** — bulk-archive `ai_draft` questions older than N days (default 7). Run it weekly or after every smoke campaign.
- **`tools/cleanup-orphaned-attempts.ts`** — mark `running` generation attempt rows older than N minutes (default 30) as `failed` with `error_code='ORPHANED'`. Run it hourly or after any deploy that may have killed in-flight generation.

Both scripts default to **dry-run** (print-only); pass `--apply` to write.
Both use `SET LOCAL ROLE assessiq_system` for cross-tenant access.

## Cut over the email sender (Resend cutover)

**Goal:** change the SMTP provider and the sender address.

> **History.** Production moved from Resend to Brevo on 2026-09-20. The sender is now `AssessIQ <connect@assessiq.in>`.

> **SUPERSEDED (2026-05-24).** This is the original *plan* of 2026-05-21, which targeted `automateedge.cloud`. The team executed the cutover on 2026-05-24 against **`assessiq.in`** (verified in Resend through Cloudflare DNS), with the sender `AssessIQ <noreply@assessiq.in>`. See **"Platform email sender → Resend (2026-05-24)"** above for the as-built record. The steps below stay for reference. Substitute `assessiq.in` for `automateedge.cloud` throughout.

Production should send mail through Resend, not through a personal Gmail. As of 2026-05-21, the live `.env` was still set to `smtps://manishjnvk@gmail.com:<app-password>@smtp.gmail.com:465`. This leaks the personal Gmail of the operator in the From: header AND fails DMARC against `assessiq.automateedge.cloud`, which pushes transactional mail toward spam.

**Sender identity (zero-budget):** `AssessIQ <noreply@automateedge.cloud>`. The team already owns the root domain (it is the parent of `assessiq.automateedge.cloud`), so no new domain registration is needed. If the team registers `assessiq.in` later, the same Resend account verifies it as a second domain in 5 minutes. Only the `EMAIL_FROM` env var needs to change.

**Why Resend:** The free tier covers 3,000 emails/month and 100/day. It uses standard SMTP, so `modules/13-notifications/src/email/transport.ts` works unchanged. The IPs of Resend and the DKIM signing on our domain back the deliverability.

### One-time setup (off-platform)

1. **Sign up** at `resend.com` with `manishjnvk@gmail.com`. Free tier, no card.
2. **Add domain** → enter `automateedge.cloud`. Resend lists 4 DNS records to add: 1 × MX (return-path), 1 × TXT-SPF, 2 × TXT-DKIM. (Or use the subdomain `assessiq.automateedge.cloud` for reputation isolation from neighbor apps on the shared VPS; see `CLAUDE.md` rule #8. The subdomain choice does NOT require an immediate change of the Zod default in `modules/00-core/src/config.ts`. The env var override is sufficient.)
3. **Add the DNS records** at the registrar for `automateedge.cloud` (Hostinger DNS: sign in to `hpanel.hostinger.com` → Domains → `automateedge.cloud` → DNS). Copy the Host / Type / Value fields verbatim from Resend. Wait ~10 min for propagation, and click **Verify** in Resend until all 4 records turn green.
4. **(Recommended) Add a DMARC record.** Add a TXT record at `_dmarc.automateedge.cloud`:

   ```text
   v=DMARC1; p=none; rua=mailto:manishjnvk@gmail.com; pct=100; adkim=s; aspf=s
   ```

   `p=none` = report-only; nothing bounces. Tighten to `p=quarantine` later, once the volumes settle.
5. **Generate SMTP credentials** in the Resend dashboard → SMTP tab → create a new credential. Resend returns a connection string of the form `smtps://resend:re_XXXXXXXX@smtp.resend.com:465`. Store the API key in a password manager.

### Cutover on the VPS

```bash
ssh assessiq-vps
cd /srv/assessiq

# Verify which env file docker-compose reads — should be /srv/assessiq/.env
docker compose -f infra/docker-compose.yml config | grep -E "SMTP_URL|EMAIL_FROM"

# Edit /srv/assessiq/.env. Replace:
#   SMTP_URL=smtps://manishjnvk@gmail.com:<app-password>@smtp.gmail.com:465
#   EMAIL_FROM="AssessIQ <manishjnvk@gmail.com>"
# With:
#   SMTP_URL=smtps://resend:re_XXXXXXXX@smtp.resend.com:465
#   EMAIL_FROM="AssessIQ <noreply@automateedge.cloud>"

# Restart only the services that read SMTP — assessiq-api (for synchronous sends if any)
# and assessiq-worker (for the BullMQ email queue). Additive-only; no shared infra touched.
docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker
```

### Verification after cutover

1. **Smoke test.** In the AssessIQ admin UI, invite a sandbox email address to a sandbox assessment.
2. **From: header.** Open the received mail in Gmail → "Show original" → confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS` and `From: AssessIQ <noreply@automateedge.cloud>`.
3. **Resend dashboard.** The send appears in **Emails** with the status `delivered`.
4. **Log grep on the VPS.** `docker logs assessiq-worker --since 5m | grep -i "from:"` shows no `manishjnvk@gmail.com` references.
5. **Per-tenant override unaffected.** `select id, smtp_config from tenants where smtp_config is not null;` — any tenant-level overrides still take priority through `resolveFromAddress()` in `modules/13-notifications/src/email/transport.ts`.

### Post-cutover security hygiene

**Revoke the leaked Gmail app-password.** The Gmail app-password that the team used before the cutover was committed to `.env.local` (gitignored, but present in the live VPS file and in any local working copies). After you verify the Resend swap:

1. `myaccount.google.com` → Security → 2-Step Verification → App passwords.
2. Find the entry matching the AssessIQ relay; click the trash icon.
3. The old credential stops working immediately. Any forgotten copies in dev environments stop being a risk.

### Limits & follow-ups

- **Resend free tier daily cap = 100 emails.** Cohort blasts of more than 100 emails a day bounce the 101st email. Monitor in the Resend Emails tab. Move to the $20/mo tier (50K/mo, 1K/day) the first time the cap bites.
- **In-flight queue.** Emails that someone enqueued in BullMQ *before* the env swap still carry the old From:. Drain the queue (or accept a few minutes of mixed senders) before you declare the cutover complete.
- **DNS records — record them here.** Once the 4 Resend records and the DMARC record are live, append a row for each record to the DNS table below for future operator reference.

## Edit the `.env` file (`/srv/assessiq/.env`)

**Goal:** set the production environment variables.

```ini
# Domain (canonical host — switched from assessiq.automateedge.cloud on 2026-05-22)
ASSESSIQ_BASE_URL=https://assessiq.in
NODE_ENV=production

# Postgres
DATABASE_URL=postgres://assessiq:<read-from-secrets-file>@assessiq-postgres:5432/assessiq

# Redis
REDIS_URL=redis://assessiq-redis:6379

# Master encryption key (32-byte base64) — TOTP secrets, embed secrets, recovery codes, webhook secrets
ASSESSIQ_MASTER_KEY=<base64-encoded-32-bytes>

# Session signing (32-byte base64)
SESSION_SECRET=<base64-encoded-32-bytes>
SESSION_COOKIE_NAME=aiq_sess

# Google OIDC (admin login)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT=https://assessiq.in/api/auth/google/cb

# Email (SMTP — live Phase 3, 2026-05-03)
# UPDATE 2026-09-20: production moved from Resend to Brevo. /srv/assessiq/.env now has
#   SMTP_URL=smtp://<brevo-login with @ written as %40>:<brevo-smtp-key>@smtp-relay.brevo.com:587   (smtp://, STARTTLS; NOT smtps://)
#   EMAIL_FROM="AssessIQ <connect@assessiq.in>"   (was noreply@assessiq.in; owner's convention is connect@<domain> everywhere)
# assessiq-api + assessiq-worker recreated with `up -d --no-deps`; verified from inside assessiq-api (nodemailer verify + send, 250 OK).
# Rollback: /srv/assessiq/.env.bak-20260919-200230. Brevo blocks SMTP from unknown IPs, so a new server must be authorised in
# Brevo > Settings > Security > Authorized IPs first. Shared 300/day quota across all products. Full reference for every domain:
# E:\code\Foxfiber\docs\email-setup.md. The Resend notes below are kept as history.
# SMTP_URL format: smtps://apikey:<RESEND_API_KEY>@smtp.resend.com:465
# Leave EMPTY to activate stub-fallback: emails written to /var/log/assessiq/dev-emails.log
# (or ASSESSIQ_DEV_EMAILS_LOG env override). No deploy breakage if unset.
# Provision: create an API key at resend.com → Sending → API Keys (SMTP scope),
# then set SMTP_URL=smtps://apikey:<key>@smtp.resend.com:465 and restart assessiq-api + assessiq-worker.
SMTP_URL=
# History: the line below is the Resend-era sender. Production now uses EMAIL_FROM="AssessIQ <connect@assessiq.in>" (Brevo, 2026-09-20).
EMAIL_FROM="AssessIQ <noreply@assessiq.in>"

# Observability
LOG_LEVEL=info
# LOG_DIR activates per-stream JSONL files in 00-core's logger. Set in
# production; leave UNSET in dev/test (stdout-only). Bind-mounted to the
# host at the same path. See docs/11-observability.md § 3.
LOG_DIR=/var/log/assessiq
SENTRY_DSN=

# Phase 1 AI grading runs as Claude Code CLI on this VPS under the admin's Max account.
# Do NOT set ANTHROPIC_API_KEY here — see CLAUDE.md rule #1 and docs/05-ai-pipeline.md.
# Phase 2 will introduce AI_PIPELINE_MODE=anthropic-api with a budgeted key, gated.
AI_PIPELINE_MODE=claude-code-vps

# Tenant purge (RW-48b) — worker only. Unset or any value but "true" = dry run.
# TENANT_PURGE_ENABLED=true

# User purge (LC-2) — worker only. Unset or any value but "true" = dry run.
# USER_PURGE_ENABLED=false

# Plan tier gates and limits (PT1, PT-4) — API. Default false = every gate is a no-op.
# PLAN_TIERS_ENFORCED=false

# Rate limiting — optional; Zod defaults are 100/30/30/600 req/min/IP per tier.
# Set only to tune for your traffic; zero-config deploy works without any of these.
# RATE_LIMIT_IP_ADMIN=100     # admin/reviewer session: 100 req/min/IP
# RATE_LIMIT_IP_USER=30       # candidate session:       30 req/min/IP
# RATE_LIMIT_IP_ANON=30       # anonymous (no session):  30 req/min/IP
# RATE_LIMIT_IP_APIKEY=600    # API-key callers:        600 req/min/IP
```

**Local development:** the same keys live in `.env.local` at the repo root (gitignored: `.gitignore` covers `.env.*` with a `!.env.example` allowlist). Never commit values. Only `.env.example` is in the repo.

### `TENANT_PURGE_ENABLED` (RW-48b, S10, 2026-10-15)

- **What it does.** The worker job `tenant-purge-cron` runs daily at 03:30 UTC (1 attempt). It purges tenants that stayed archived for 180 days or more. Design: `docs/04-auth-flows.md` § "Tenant purge".
- **Default.** Unset means off. The job runs as a dry run. It lists candidates and changes no row.
- **Where it is read.** Only the worker reads `process.env.TENANT_PURGE_ENABLED === "true"`. The API and the `00-core` config do not read it. Set it in the worker environment only.
- **Before you enable it.**
  1. Read the worker log line `tenant-purge-cron tick`. It shows `dryRun`, `candidates`, `purged` and `failed`.
  2. Make sure that every candidate is a tenant you want to destroy. The purge cannot be undone.
  3. Take a database backup.
  4. Set `TENANT_PURGE_ENABLED=true` and recreate the worker.
- **Not included.** The job does not purge S3 or Redis data. It has no cap on tenants per run.

### `USER_PURGE_ENABLED` (LC-2, S14, 2026-10-16)

- **What it does.** The worker job `user-purge-cron` runs daily at 03:45 UTC. It purges users that were soft-deleted for 180 days or more. The users row stays as a tombstone. Design: `docs/plans/TENANT_USER_LIFECYCLE.md`.
- **Default.** `false` (unset means the same). The job runs as a dry run and changes no row.
- **Where it is read.** Only the worker reads it. Set it in the worker environment only.
- **Before you enable it.**
  1. Read the worker log line `user_purge.tick`. It shows `dryRun`, `tenants`, `purged`, `skipped` and `failed`.
  2. Take a database backup. No restore is possible after a purge.
  3. Set `USER_PURGE_ENABLED=true` and recreate the worker.

### `PLAN_TIERS_ENFORCED` (PT1, PT-4, S14, 2026-10-16)

- **What it does.** The flag turns on the plan tier gates and limits of module 19-billing (see `modules/19-billing/SKILL.md`). A denied call returns 403 with `TIER_NOT_INCLUDED`, `TIER_LIMIT_REACHED` or `CREDITS_HARD_CAP`.
- **Default.** `false` (declared in `.env.example`). While it is false, every gate and limit is a no-op. The billing page shows the limits for information only.
- **Where it is read.** The `00-core` config (`config.PLAN_TIERS_ENFORCED`).
- **Before you enable it.** Check that no current organisation on the free tier loses a feature it uses. The check is in `modules/19-billing/SKILL.md` § "Owner gate". Unset on the VPS means off.

**Migrations for this change.** This deploy applies two migrations by hand with the existing procedure (`psql -1 -v ON_ERROR_STOP=1`, then record them in `schema_migrations` with the sha256):
- `0170` (`modules/02-tenancy/migrations/0170_tenant_purge.sql`) adds `purged` to `tenants_status_check`.
- `0171` (`modules/16-help-system/migrations/0171_seed_rw45_account_security_help.sql`) adds 9 help rows. Do not run the seed file by hand.

## Edit the compose file (`infra/docker-compose.yml`)

**Goal:** change the stack definition. The repo file reaches the VPS with `git pull`.

> **Layout note (Phase 0 G0.A, 2026-05-01):** The compose file lives in the repo at `infra/docker-compose.yml`, not at the repo root. On the VPS clone it sits at `/srv/assessiq/infra/docker-compose.yml`. Run all commands from `/srv/assessiq/` with the explicit `-f` flag, for example `docker compose -f infra/docker-compose.yml up -d`. The system resolves relative paths inside the compose file from the location of the compose file: `../.env` → `/srv/assessiq/.env`, `../secrets/pg_password.txt` → `/srv/assessiq/secrets/pg_password.txt`, `./postgres/init` → `/srv/assessiq/infra/postgres/init`, build context `..` → `/srv/assessiq/`.
>
> **`env_file` is declared with `required: false`**, so `docker compose config` validates cleanly on a fresh clone before you provision the secrets. `modules/00-core/src/config.ts` preserves the runtime safety: Zod validation throws on the first request if any required env var is missing.

```yaml
name: assessiq

x-defaults: &svc-defaults
  restart: unless-stopped
  init: true
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }

networks:
  assessiq-net:
    name: assessiq-net
    driver: bridge

volumes:
  assessiq_pgdata:
  assessiq_redis:

secrets:
  pg_password:
    file: ./secrets/pg_password.txt

services:
  assessiq-postgres:
    <<: *svc-defaults
    image: postgres:16-alpine
    container_name: assessiq-postgres
    networks: [assessiq-net]
    environment:
      POSTGRES_DB: assessiq
      POSTGRES_USER: assessiq
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    volumes:
      - assessiq_pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    secrets: [pg_password]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U assessiq -d assessiq"]
      interval: 10s
      timeout: 3s
      retries: 5

  assessiq-redis:
    <<: *svc-defaults
    image: redis:7-alpine
    container_name: assessiq-redis
    networks: [assessiq-net]
    command: ["redis-server", "--appendonly", "yes", "--save", "60 1000"]
    volumes:
      - assessiq_redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      retries: 5

  assessiq-api:
    <<: *svc-defaults
    image: assessiq/api:${IMAGE_TAG:-latest}
    container_name: assessiq-api
    build:
      context: .
      dockerfile: ./infra/docker/api.Dockerfile
    networks: [assessiq-net]
    env_file: .env
    depends_on:
      assessiq-postgres: { condition: service_healthy }
      assessiq-redis: { condition: service_healthy }
    expose: ["3000"]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/api/health"]
      interval: 15s
      retries: 3

  assessiq-worker:
    <<: *svc-defaults
    image: assessiq/api:${IMAGE_TAG:-latest}
    container_name: assessiq-worker
    command: ["node", "dist/worker.js"]
    networks: [assessiq-net]
    env_file: .env
    depends_on:
      assessiq-postgres: { condition: service_healthy }
      assessiq-redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "dist/worker-health.js"]
      interval: 30s
      retries: 3

  assessiq-frontend:
    <<: *svc-defaults
    image: assessiq/frontend:${IMAGE_TAG:-latest}
    container_name: assessiq-frontend
    build:
      context: .
      dockerfile: ./infra/docker/assessiq-frontend/Dockerfile
    networks: [assessiq-net]
    # Bound to all interfaces on host port 9091 so ti-platform-caddy-1 (on a different
    # Docker network) can reach it via the bridge gateway 172.17.0.1:9091.
    # No other host port is published.
    ports:
      - "9091:80"
    depends_on:
      assessiq-api: { condition: service_healthy }
```

**Notes:**

- No `nginx` service. No `certbot` service. Caddy on the box does the TLS for us.
- The container names are explicit (`container_name: assessiq-*`) per CLAUDE.md rule #8.
- Only `assessiq-frontend` exposes a host port (`9091`). API, worker, postgres and redis are all internal to `assessiq-net`.
- `assessiq-api` does not get a host port. Caddy never talks to the API directly. The nginx of the frontend (inside its container) reverse-proxies `/api`, `/embed`, `/take` and `/ws` to `assessiq-api:3000` on the internal network.

### Memory limits and the worker healthcheck (RW-4, 2026-10-09)

**What and why.** Every service in `infra/docker-compose.yml` has a `mem_limit`. `assessiq-worker` has a Redis PING healthcheck. The VPS has 8 GB, and other apps use about 3.8 GB of it. A runaway container must not starve them.

| Service | `mem_limit` | Live use at the time |
| --- | --- | --- |
| `assessiq-api` | 2g | 180M |
| `assessiq-worker` | 1g | 184M |
| `assessiq-postgres` | 1g | 32M |
| `assessiq-redis` | 256m | 7M |
| `assessiq-frontend` | 128m | under 4M |
| `assessiq-marketing` | 128m | <4M (nginx) |

**Probe mechanics.** The probe is a Node stdlib one-liner. It opens a TCP socket to the host and port of `REDIS_URL`. It sends PING and expects PONG. The timeout is 3 s. The interval is 30 s, retries are 3, and start_period is 20 s.

> [!WARNING]
> Do not write `\r\n` in a double-quoted YAML scalar that holds code. YAML turns it into real CR and LF characters, and the JS string breaks. Use `'PING'+String.fromCharCode(13,10)`. Run `docker compose config --format json` to see the parsed command.

**Rejected.** `redis-cli` and `wget` are not in the `node:22-slim` image. An HTTP probe does not work, because the worker has no port.

**Not included.**
- A cap for the whole stack. The caps sum to 4.5 GiB, so they bound each service only.
- A process-liveness probe. The PING proves that Redis is reachable. A wedged worker still reads healthy. `restart: unless-stopped` covers a crash.
- Redis 256m is the tightest cap, because of the AOF rewrite. Raise it if the AOF grows.

**Impact.** Recreate every service after you edit `mem_limit`. `docker restart` does not apply a new limit. Use `up -d --no-deps --force-recreate <svc>`, one service at a time.

**Verify.**
1. Run `docker inspect -f '{{.HostConfig.Memory}}' <container>` for each service. The value is in bytes.
2. Run `docker inspect -f '{{json .State.Health}}' assessiq-worker`. Status is `healthy` and the last log `ExitCode` is 0.

## E2E test minter (`ENABLE_E2E_TEST_MINTER`): production invariant

**Goal:** confirm that the test minter route is off in production. Run this check after every API deploy.

The team added this on 2026-05-08, with the `admin-workflow.spec.ts` Playwright E2E suite. The route `POST /api/dev/mint-session` is a dev-only way to bootstrap authenticated sessions without Google SSO. It enables E2E tests in CI without interactive OAuth.

**Invariant: `ENABLE_E2E_TEST_MINTER` must be absent (or `"false"`) in `/srv/assessiq/.env` at all times.** The server does not register the route at startup unless the env var is `"true"`, so the route physically does not exist in the prod module graph. This is stronger than a runtime 403.

Verification (run it after every API deploy):
```bash
curl -I https://assessiq.automateedge.cloud/api/dev/mint-session
# Expected: 404 Not Found (NOT 401 or 200)
```

If the curl returns anything other than 404, the env var is misconfigured. Remove it from `/srv/assessiq/.env` and restart `assessiq-api` immediately.

The env var is intentional in these places:
- Local dev: `ENABLE_E2E_TEST_MINTER=true pnpm --filter @assessiq/api dev`
- Staging/CI: set it on the staging server only, never in production

**Update 2026-10-03 (RS11).**
- **Local stack.** `apps/web/e2e/local-stack.sh` starts throwaway `assessiq-e2e-*` Postgres and Redis containers, applies the migrations, and starts the API, the worker and the web dev server with `ENABLE_E2E_TEST_MINTER=true`. `--down` removes exactly those containers. Nothing here touches the VPS.
- **Minter fix (`ac8b8cb`).** The dev minter used `ON CONFLICT (tenant_id, lower(email))`, but no index matched. Every new candidate got a 500. It now uses `(tenant_id, email)`. The same commit fixed the Vite dev proxy.
- **CI.** The `e2e` job (`09595fa`) starts its own `postgres` and `redis` services in the runner. It does not need the repo variables `E2E_BASE_URL` or `E2E_API_BASE_URL`.
- **Required since E13 (2026-10-09).** The team removed `continue-on-error` after the job was green on seven consecutive runs where it ran (37400230396 to 37893018042). The only red run, 37422949382, failed in `quality` on a handlebars advisory and skipped e2e. A red e2e job now blocks the workflow.
- **Rejected.** Keeping it advisory until the team fixes the flaky totp timing test (that test runs in `quality`, not in e2e).
- **Not included.** A retry-on-flake step for e2e (Playwright already retries twice in CI).
- **Downstream.** `apps/web/e2e/README.md` § Running in CI; the `.github/workflows/ci.yml` comment above the `e2e` job.
- **Prod invariant unchanged.** The flag stays absent or `false` in `/srv/assessiq/.env`.

See `apps/web/e2e/README.md` for the full guide to local runs and CI integration.

## Authenticated Origin Pulls (AOP) — origin TLS-locked to Cloudflare (live 2026-05-20)

**Goal:** make the origin accept only Cloudflare handshakes.

This closes the confirmed IP-spoof vulnerability (see `docs/RCA_LOG.md` 2026-05-19 and 2026-05-20) at the TLS layer. The origin rejects any HTTPS handshake that does not present the zone-level Origin Pull client certificate of Cloudflare. This is the **complete** fix. The app-layer `x-origin-verify` shared secret (see `docs/04-auth-flows.md § Origin-verify header`) is defense in depth.

**State (verified):**

- The AssessIQ block of the Caddyfile (`/opt/ti-platform/caddy/Caddyfile`) carries `tls ... { client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/ssl/cf-origin-pull-ca.pem } }`. **Only the AssessIQ site block has `client_auth`.** The neighbors (`intelwatch.in`, `ti.intelwatch.in`, `automateedge.cloud`, `accessbridge.space`) are untouched and remain on standard TLS.
- The CA cert (host) `/opt/ti-platform/caddy/ssl/cf-origin-pull-ca.pem` is the canonical Cloudflare Origin Pull CA (`CN=origin-pull.cloudflare.net`, SHA-256 `9A:1A:C2:B4:...:25:A2:B9`, valid through Nov 2029). Mount: `/opt/ti-platform/caddy/ssl → /etc/caddy/ssl` (host → container).
- Cloudflare side: zone-level AOP is enabled in the dashboard (Zone → SSL/TLS → Origin Server → Authenticated Origin Pulls → ON).

**Flip procedure (canary with auto-revert; reuse it for any future Caddy edit):**

```bash
# Backup is a SEPARATE file (cp safe; bind-mount inode trap only applies to the live file).
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.${TS}

# Truncate-write the edit (sed -i / mv would change inode -> bind-mount sees stale content; RCA 2026-04-30).
NEW=$(sed "s/mode request/mode require_and_verify/" /opt/ti-platform/caddy/Caddyfile)
printf "%s\n" "$NEW" > /opt/ti-platform/caddy/Caddyfile      # same inode

# Validate before reload — Caddy keeps old config on validate-fail, but explicit is better.
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec ti-platform-caddy-1 caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile

# 4-probe acceptance gate
CF=$(curl -s -m 8 -o /dev/null -w "%{http_code}" https://assessiq.automateedge.cloud/api/health)        # need 200
SP=$(curl -s -m 10 -k --resolve assessiq.automateedge.cloud:443:72.61.227.64 \
       -H "CF-Connecting-IP: 203.0.113.99" -o /dev/null -w "%{http_code}" \
       https://assessiq.automateedge.cloud/api/health)                                                   # need NOT 200
N1=$(curl -s -m 8 -o /dev/null -w "%{http_code}" https://accessbridge.space)                            # need 200
N2=$(curl -s -m 8 -L -o /dev/null -w "%{http_code}" https://automateedge.cloud)                         # need 200

# Auto-revert if the CF probe fails
if [ "$CF" != "200" ]; then
  cat /opt/ti-platform/caddy/Caddyfile.bak.${TS} > /opt/ti-platform/caddy/Caddyfile   # truncate-write again
  docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
```

**Rollback.** Use the same `cat backup > Caddyfile` pattern, then reload. `.bak.<TS>` files accumulate in `/opt/ti-platform/caddy/` (5 visible at last check, oldest May 2). Keep the last few and prune the older ones.

**Operational notes:**

- **Bind-mount inode trap (RCA 2026-04-30)**: NEVER `mv newfile /opt/ti-platform/caddy/Caddyfile` and NEVER `sed -i`. Those commands create a new inode, and the Docker bind-mount continues to point at the orphaned old inode. Caddy then reloads from the OLD content. Use truncate-write (`cat >`, `printf >`, `tee` w/o `-a`), so the inode is preserved.
- **Caddy admin API**: `docker exec ti-platform-caddy-1 wget -qO- http://127.0.0.1:2019/config/` returns the currently loaded JSON config. Use it to verify that the `client_auth`/`trusted_ca_cert` keys are actually present after the reload (do not assume this from the Caddyfile diff alone).
- **Caddy deprecation warning** that Caddy logs on reload: `'trusted_ca_cert_file' field is deprecated. Use the 'trust_pool' field instead.` (Caddy v2.11.1). It is non-breaking. The team tracks it as a Caddyfile hygiene follow-up.

## Domain switch to assessiq.in (2026-05-22)

**Goal:** serve the product on `assessiq.in`.

**Status: LIVE & verified (2026-05-22).** All phases shipped. `assessiq.in` serves with the AOP origin lock. `www.assessiq.in` → apex. `assessiq.automateedge.cloud` sends a 301 to `assessiq.in` (path and query preserved, still AOP-locked). The `.env` base URL and OIDC are flipped. The frontend is rebuilt. `ORIGIN_VERIFY_SECRET` is rotated. The end-to-end test sweep is green (health, SPA, SSO 302→assessiq.in, `/take/start` 404 not 429, direct-origin spoof rejected on both hosts, neighbors untouched). One gotcha cost a debugging cycle. See prerequisite #3 and RCA 2026-05-22.

**What changed.** The canonical public host moved from `assessiq.automateedge.cloud` to **`assessiq.in`**. `assessiq.in` now serves the app, and `assessiq.automateedge.cloud` sends a 301 redirect to it. The repo-side config changed in these places: `ASSESSIQ_BASE_URL` and `GOOGLE_OAUTH_REDIRECT` (`.env.example`, prod `.env`, `vitest.setup.ts` default), the Caddy site blocks (`infra/caddyfile/assessiq.snippet`), the candidate-facing footer strings (`CandidateLogin.tsx`, `TakeRightPane.tsx`), the embed-SDK CDN doc comment, and assorted test and tooling references.

**Why.** `assessiq.in` is the brand domain. `assessiq.automateedge.cloud` was always a stop-gap subdomain on existing infra (PROJECT_BRAIN decision 2026-04-29). A single canonical host keeps the email links, the session-cookie scope and the SSO callbacks on one origin.

**Why a redirect, not a hard cutover.** Cookies are host-only (no `domain=` attribute), and the two hosts share no common parent. So a session cannot span both hosts. There is no "alias" option that keeps you signed in across both. A 301 from the old host preserves the magic-link and invitation tokens that people already received (the token rides through in the path or query) and the live bookmarks. We chose this over a removal of the old host, which would return 404 for in-flight candidate emails.

**Prerequisites (dashboards; only the operator can do them; do them BEFORE the env flip):**

1. **Cloudflare (assessiq.in zone; it already exists):** proxied A record `assessiq.in` → `72.61.227.64` (and `www` if used); SSL/TLS mode **Full (Strict)**.
2. **Cloudflare AOP (REQUIRED):** Zone → SSL/TLS → Origin Server → **Authenticated Origin Pulls** → switch the **Global** toggle ON ("Cloudflare will use a **shared** TLS client certificate"). ⚠️ Use **Global**, NOT **Zone-level**. Global presents the shared Origin-Pull cert of CF (`CN=origin-pull.cloudflare.net`), which is exactly what the box trusts through `cf-origin-pull-ca.pem`. The box reuses it as is, with no new CA. **Zone-level is the _custom-certificate_ path.** Leave it OFF and do NOT upload a cert there. If someone uploaded a custom cert, CF would present a cert that the origin does not trust, and every handshake would be rejected (the site would be down). Without Global AOP on, the Caddy `client_auth { mode require_and_verify }` rejects every assessiq.in handshake.
3. **Cloudflare Transform Rule (REQUIRED; it must be a _Request Header_ rule):**
   - Go to the assessiq.in zone → **Rules → Transform Rules → Modify _Request_ Header** → match "All incoming requests" → `Set static x-origin-verify = <ORIGIN_VERIFY_SECRET>` → Deploy.
   - Prod runs `ORIGIN_TRUST_MODE=enforce`, and the check of the app ([client-ip.ts](../modules/01-auth/src/client-ip.ts), [rate-limit.ts](../modules/01-auth/src/middleware/rate-limit.ts)) **fails closed**. Without this rule, every rate-limited or auth route returns `429 "missing client IP for rate limit"`.
   - ⚠️ **It MUST be a _Request_ header, NOT Response.** A Response-header rule never reaches the app (origin-verify fails → 429) **and** it broadcasts the secret to every visitor (this exact mistake cost a cycle on 2026-05-22; see RCA).
   - The Origin-Pull CA is shared across zones, but the value of `x-origin-verify` is per deployment. Keep the rule value and `ORIGIN_VERIFY_SECRET` in `.env` byte-identical.
   - The limiter exempts the health endpoints. So verify with a rate-limited route (`POST /take/start` → expect 404, not 429), not with `/api/health`.
4. **Origin Certificate:**
   - Go to SSL/TLS → Origin Server → **"Origin Certificates" tab**. This tab is distinct from the "Authenticated Origin Pulls" tab in #2. These are two different certs: AOP = the cert that CF presents *to* the origin; this = the cert that the origin presents *back to* CF.
   - Click **Create Certificate**. It must cover `assessiq.in` + `*.assessiq.in`, RSA, 15-year.
   - Place it at `/etc/caddy/ssl/assessiq.in.{pem,key}`, and run `chmod 0600` on the key.
   - ⚠️ The dashboard shows the **private key only once**. Copy it before you close the page.
   - If you paste by hand, watch for leading whitespace or CRLF that the editor adds. A PEM with a leading tab fails the `openssl` parse (clean it with `sed -e 's/\r$//' -e 's/^[[:space:]]*//'`).
   - Verify after the install: `openssl x509 -in …pem -noout -modulus | openssl md5` must equal `openssl rsa -in …key -noout -modulus | openssl md5`.
5. **Google OAuth console:** add `https://assessiq.in/api/auth/google/cb` to the **Authorized redirect URIs** of the OAuth client (keep the old one until the redirect is live). A mismatch makes SSO fail closed. You can leave **Authorized JavaScript origins** **empty**. The flow is server-side (`window.location → /api/auth/google/start → Google → /api/auth/google/cb`), so Google does not enforce a JS origin. Only the redirect URI matters. (Setting `https://assessiq.in` there is harmless but unnecessary.)

**Staged rollout (the order matters; see the header of `infra/caddyfile/assessiq.snippet`):** In Phase 1, add the `assessiq.in` Caddy block alongside the old block, which still serves (zero impact). In Phase 2, flip the two env vars and redeploy api, worker and frontend. In Phase 3, swap the old block to the `redir … permanent` form. Each phase has a smoke gate. The 4-probe curl set in the snippet includes the AOP direct-origin-spoof check (it must NOT return 200).

**Explicitly NOT included.** (a) `EMAIL_FROM` stays `noreply@automateedge.cloud`. The move of the mail-sender domain to `noreply@assessiq.in` is a separate workstream (it needs SPF/DKIM/DMARC DNS on assessiq.in), and bundling it would risk deliverability. **[Superseded 2026-05-24: the team completed that workstream. Production now sends from `noreply@assessiq.in`. See "Platform email sender → Resend (2026-05-24)" below.]** (b) No per-tenant custom-domain mapping (still a v2 item). (c) The team left the historical references in the decision log of PROJECT_BRAIN and in prior session docs as they are (a record of what was true then).

**Downstream impact.** Embed customers who use the CDN `<script src>` must update it to `assessiq.in` (the tenant configures the embed JWT `allowedOrigins` separately, so they are unaffected). Any external monitor or uptime check that points at the old host keeps working through the 301. The `tests/load` PROD_PATTERNS guard now lists `assessiq.in`, so load tests stay blocked against the new prod host.

## SEO marketing site: the `assessiq-marketing` container (Phase 0, 2026-05-22)

**Goal:** deploy or change the marketing site.

**Status: LIVE & PUBLIC (2026-05-22).** `assessiq.in` now serves the Astro marketing site (the Caddy default route → 9093). The SPA serves `/admin` `/candidate` `/take` + `/assets/*` `/brand/*` through `@app` (→9091). The API serves `/api/*` and the other API paths through `@api` (→9092).

Verified live:

- The home title = the marketing title.
- `/admin/login` + the SPA bundle `/assets/*.js` → 200.
- `/api/health` → 200.
- AOP direct-origin spoof → rejected (000).
- Neighbor `accessbridge.space` → 200.
- The legacy host → 301 → assessiq.in.
- `robots.txt` + `sitemap-index.xml` served to a Googlebot UA through Cloudflare.

**What it is.** `apps/marketing/` is a standalone Astro static site, the public SEO surface. **Phases 1–4 (live 2026-05-23) — 45 indexable pages, 45-URL sitemap:**

- P1 = home/about/contact/`/pricing`/`/security` + 4 `/solutions/*` + `llms.txt`.
- P2 = `/compare` (3 head-to-head) + `/alternatives` (5) + `/solutions` hub.
- P3 = `/glossary` (10 terms) + `/tests` skill library (8 skills).
- P4 = `/resources` blog (1 pillar + 2 supporting) + `/methodology`.

The site also has `robots.txt`, a Header (Solutions/Resources dropdowns + Compare/Skill Tests/Pricing) and a grouped Footer. It has the full §3.5 head contract and per-page JSON-LD: Organization/WebSite/SoftwareApplication on home; Service+FAQPage+BreadcrumbList on solutions/tests; Article+FAQPage on compare/alternatives/resources; DefinedTerm on glossary. The site has no fabricated prices/Offer, no unearned SOC2/ISO certs, no ratings, and no fabricated competitor claims or authors. New marketing pages need NO Caddy change (they fall to the default→9093 route). The team built it per `docs/design/seo-marketing-site-architecture.md` and `docs/design/SEO_Strategy.md` §17. The React SPA stays the gated app and remains `noindex`.

**Trust pages + Google Safe Browsing remediation (2026-05-23).** Google Search Console flagged `assessiq.in` with a **"Deceptive pages" (social-engineering)** Safe Browsing issue (Sample URLs: N/A).

**What changed:**

- The team added `/privacy` (DPDP-Act-2023-aligned Privacy Policy) and `/terms` (Terms of Service) as Astro pages (`apps/marketing/src/pages/{privacy,terms}.astro`, mirroring the `security.astro` pattern + breadcrumb JSON-LD).
- The Footer "Company" column links to them sitewide. The team added them to the **hardcoded** sitemap in `astro.config.mjs` (45→47 URLs).
- The team hardened the SPA login (`apps/web/src/pages/admin/login.tsx`). The H1 changed from "Sign in to continue." to "Sign in to AssessIQ.", and Terms/Privacy links now appear under the auth buttons.
- The team added Privacy/Terms links to the candidate landing (`apps/web/src/pages/take/TokenLanding.tsx`).
- Separately, the team added `apps/marketing/public/BingSiteAuth.xml` for Bing Webmaster verification.

**Why:** The most probable trigger of the flag is the textbook false-positive profile. The domain is brand new. The login hero CTA is "Continue with Google". The site has **no Privacy/Terms anywhere** (Safe Browsing crawls login pages regardless of the `robots.txt` Disallow). Strong self-identification and sitewide legal links are the standard legitimacy signals that clear the flag.

**Considered & rejected:** The Bing HTML-meta-tag verification (it would inject a tag into all ~45 pages, so the team used the single XML file instead). An immediate GSC review request (the team held it until the hardening shipped, so the appeal lands on a fixed page, not in a repeat-offender cooldown).

**Placeholders filled (2026-05-24, commit on `main`):** entity "AssessIQ", address Bommanahalli/Bangalore 560068, jurisdiction Bangalore, effective date May 2026. The grievance section no longer names a dedicated officer or a `grievance@` inbox. It routes to the published `connect@assessiq.in`. `terms.astro` says "based in India" and not "a company incorporated under the laws of India", pending confirmation of the incorporation status of AssessIQ (restore the stronger wording if it is a registered company). The GSC "Request Review" and Bing "Verify" clicks remain operator-gated.

**Downstream impact:** The team rebuilt `assessiq-marketing` (47 pages) and `assessiq-frontend` (login copy). The login screen in `docs/04-auth-flows.md` now reads "Sign in to AssessIQ" with legal links. Commits `657ee2a` (Bing file) + `ab899fe` (trust pages + login hardening), both on `main`. A note on the **hardcoded sitemap**: any *future* marketing page is silently absent from `sitemap-0.xml` until you add it to the `pages[]` array in `astro.config.mjs`. This is a known maintenance trap. The build does not discover pages automatically.

**Microsoft Clarity analytics (2026-05-24, marketing-site-only).**

**What:** The team added the Clarity tag (project `wvv1j6k46i`) as an `is:inline` `<script>` in `apps/marketing/src/layouts/BaseLayout.astro` `<head>`. It loads on the ~48 marketing pages and **nowhere else**.

**Why marketing-only:** The SPA (`apps/web`, served at `/admin` `/candidate` `/take`) does NOT use this layout. So Clarity never touches candidate PII or assessment sessions. A hard rule requires this: the Privacy Policy states that the assessment and admin app has no third-party analytics, and DPDP forbids unconsented recording of candidate data. **Do NOT** install Clarity through a Cloudflare zone-level integration or a domain-wide GTM, because that would inject it into the SPA too.

**Masking:** The Clarity dashboard Masking setting must stay at Balanced/Strict, so that it masks the `/contact` form (name/email/message) and any input. This is a dashboard setting, not code.

**Considered & rejected:** A cookie-consent banner (not yet added; DPDP leans toward consent for non-essential analytics cookies; flagged as a follow-up).

**Downstream:** The `/privacy` cookies section now discloses Clarity by name (`_clck`/`_clsk` cookies, masked session replay) and reaffirms "no analytics on the app". The team rebuilt `assessiq-marketing`. The Clarity ID is public (it ships in the page source) and is not a secret.

**Container.** `assessiq-marketing` in `infra/docker-compose.yml`: `nginx:alpine` serving Astro `dist/`, host port **9093:80** (9091=frontend, 9092=api). Dockerfile at `infra/docker/assessiq-marketing/Dockerfile` (multi-stage; **pnpm pinned to 9.15.0** via `packageManager`; node:22-alpine corepack defaults to pnpm 11, whose `minimumReleaseAge` policy breaks the frozen install of a 9.x lockfile). Standalone: `apps/marketing` is EXCLUDED from the pnpm workspace (`pnpm-workspace.yaml` `!apps/marketing`); it has its own lockfile, installed with `--ignore-workspace`.

**Deploy (steady-state):**
```bash
cd /srv/assessiq && git pull --ff-only
docker compose -f infra/docker-compose.yml build assessiq-marketing
docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-marketing
```
The team verified on 2026-05-22 on :9093: `/`, `/about`, `/contact`, `/robots.txt`, `/sitemap-index.xml`, `/favicon.svg` and `/og-default.png` → 200; `/nonexistent` → **real 404** (Astro `build.format:'file'` + nginx `try_files $uri $uri.html $uri/index.html =404`, no `$uri/` branch → no soft-404, no trailing-slash 301). The home page serves all 3 JSON-LD blocks. The team confirmed that live `assessiq.in` and `accessbridge.space` are unaffected.

**Asset routing (no collision with the SPA).** The SPA owns `/assets/*` (Vite chunks) + `/brand/*` (favicons/og). Marketing uses `/_astro/*` + ROOT favicons (`/favicon.svg` etc.) + `/og-default.png`, and deliberately NOT `/assets` or `/brand`. This is why the `@app` matcher below carries `/assets/* /brand/*`.

**DONE — Caddy flip (live 2026-05-22; `codex:rescue` ACCEPT).** The team applied the THREE-WAY split from `infra/caddyfile/assessiq.snippet` to the `assessiq.in` block in `/opt/ti-platform/caddy/Caddyfile`:
```caddy
@api  path /api/* /embed* /help/* /take/start /verify/*                 # -> 9092 (unchanged)
@app  path /admin /admin/* /candidate /candidate/* /take /take/* /assets/* /brand/*   # -> 9091 (SPA)
handle { reverse_proxy 172.17.0.1:9093 ... }                            # default -> 9093 (marketing)
```
The directives of the live block were already current (only its comments had drifted). The team applied the change in this order:

1. Back up the Caddyfile.
2. **Validate.** Run `docker cp` to copy the candidate file INTO the container, then run `caddy validate`. The Caddyfile is bind-mounted as a SINGLE FILE, so sibling files in `/opt/ti-platform/caddy/` are NOT visible at `/etc/caddy/`.
3. Do an inode-safe truncate-write (`cat new | tee Caddyfile`, NEVER `mv`/`sed -i`).
4. Run `caddy reload`.
5. Run the smoke gate with auto-revert.

Backup: `Caddyfile.bak.20260522T182634Z`. The AOP `client_auth` block is left intact. **Cloudflare injects a Managed-robots block** ahead of our `/robots.txt` (Content-Signal `search=yes, ai-train=no` + AI-bot Disallows). This is expected per SEO_Strategy §3.1. Our app-path Disallows and the `Sitemap:` directive are intact below it.
**Rollback:** `cat
tee /opt/ti-platform/caddy/Caddyfile >/dev/null && docker exec ti-platform-caddy-1
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

**Contact-form backend (2026-05-24).** The `/contact` page used a `mailto:` form action, which opened the email client of the visitor. This was unreliable on mobile, and browser UX flagged it as "not secure". The page now submits through AJAX `POST /api/contact` (the `assessiq-api` container, already behind the `@api` Caddy matcher, so no Caddy change is required).

- The endpoint is public and unauthenticated. It reuses the existing per-IP credential-tier rate limiter (`authChain({ requireSession: false, credentialEndpoint: true })`) to cap relay abuse.
- A hidden honeypot field (`company_website`) silently drops bot submissions before they hit SMTP.
- The API sends the email directly, with no BullMQ queue (contact enquiries are not tenant-scoped and carry no `email_log` row). It uses the platform Resend SMTP transport (`resolveTransport()`). `replyTo` is the address of the submitter, so the team can reply inline. The recipient is hardcoded as `connect@assessiq.in`.
- If `SMTP_URL` is unset (local dev), the API drops the enquiry to `webhook.log` with a WARN and still returns `200 { ok: true }`.
- On an SMTP error, the API returns `502 SEND_FAILED` with a fallback message that points to the direct email address.
- The feature needs no new environment variables and no Caddy changes. It is fully live once the API container is redeployed.

**Cloudflare Turnstile on the contact form (2026-05-24).** This is bot protection beyond the honeypot.

- **Frontend** (`contact.astro`): the Turnstile widget (`data-sitekey="0x4AAAAAADVMWHe1bQPyzyZJ"` — public) + `challenges.cloudflare.com/turnstile/v0/api.js`. The submit handler reads the `cf-turnstile-response` token and blocks if it is absent. It sends the token as `cf_turnstile_response` and resets the widget for each attempt (the token is single-use).
- **Backend** (`/api/contact`): a server-side `siteverify` runs before the send. It is **fail-closed**: a missing or invalid token, or a siteverify error, returns `403 TURNSTILE_FAILED`. When `TURNSTILE_SECRET` is unset, the backend rejects the request in production and skips the check only in non-prod.
- **New env var** `TURNSTILE_SECRET` in `/srv/assessiq/.env` (the widget secret key; root-owned, not in git). Recreate `assessiq-api` after you set it. The widget is `AssessIQ contact` (Managed) in Cloudflare.
- It is layered with the honeypot, the per-IP credential limiter and a global 20/hr budget.
- **codex:rescue ACCEPT** (after one REVISE: prod fail-closed on an unset secret, and the confirmation that the per-IP limiter runs before the siteverify call).
- **Sharp edge:** the backend (turnstile) and the frontend (widget) shipped in *separate* commits. If the form returns 403 on every submit, the deployed marketing build is missing the widget (the frontend is not deployed).
- To rotate the secret: regenerate it in Turnstile, update `.env`, and recreate the API.

> **History (superseded 2026-09-20):** Production now sends through Brevo SMTP from `AssessIQ <connect@assessiq.in>`. See the "UPDATE 2026-09-20" block in the env section below and `docs/13-email-system.md`. This Resend record stays as history.

**Platform email sender → Resend (2026-05-24).** The team switched the SMTP transport of the platform from a personal **Gmail SMTP** (`smtp.gmail.com`, From `manishjnvk@gmail.com`; see RCA 2026-05-24) to **Resend**. `assessiq.in` is verified in Resend (DKIM `resend._domainkey` + SPF/MX on `send.assessiq.in`, added through Cloudflare DNS). On the VPS, `/srv/assessiq/.env` (root-owned, `600`, **not** in git) now has `SMTP_URL=smtps://resend:<api-key>@smtp.resend.com:465` and `EMAIL_FROM="AssessIQ <noreply@assessiq.in>"`. This covers **all** outbound email: login OTPs and invites (queued through the worker) and contact enquiries (synchronous). Recreate `assessiq-api` **and** `assessiq-worker` after an `.env` change, because the container reads env_file at start. Verified 2026-05-24: OTP and contact email both deliver to the Gmail Inbox From `noreply@assessiq.in`. Rollback: `cp .env.bak.<ts> .env` and recreate. The Resend API key is a secret. To rotate it, create a new key in Resend → API Keys and run the `.env` swap again. **Why it mattered:** Gmail as the sender caused the deduplication of contact enquiries out of the Inbox (they forward to that same Gmail). It also leaked a personal address as the sender of every OTP and invite. Gmail SMTP also caps at ~500/day.

## Reverse-proxy plan: additive Caddyfile block

**Goal:** add or edit the AssessIQ server block in the shared Caddyfile.

The ti-platform Caddyfile (at `/opt/ti-platform/caddy/Caddyfile`) already has Cloudflare IPs in `trusted_proxies`. It uses bridge-gateway upstreams (`172.17.0.1:<port>`) to reach apps on other Docker networks (roadmap and accessbridge use this pattern today). Match that pattern. Make no edits to the `docker-compose.yml` of ti-platform, add no `extra_hosts`, and create no shared-network coupling.

Append this block to `/opt/ti-platform/caddy/Caddyfile`:

```caddy
# ═══ AssessIQ — assessiq.automateedge.cloud ═══
assessiq.automateedge.cloud {
    import security-headers   # already defined globally in this Caddyfile

    # CF Origin Cert (manually placed; 15-year validity)
    tls /etc/caddy/ssl/assessiq.automateedge.cloud.pem \
        /etc/caddy/ssl/assessiq.automateedge.cloud.key

    # AssessIQ frontend, bound to host:9091 (see compose below)
    reverse_proxy 172.17.0.1:9091 {
        header_up X-Forwarded-Proto https
        # Caddy already extracts client IP from CF-Connecting-IP via global trusted_proxies
    }

    encode zstd gzip
    log {
        output file /var/log/caddy/assessiq.log
        format json
    }
}
```

**Apply procedure (Phase 0 G0.A deploy step):**

1. Generate a CF Origin Cert in the Cloudflare dashboard (Zero Trust → Origin Server → Create Certificate, RSA 2048, 15-year). Save the cert and the private key.
2. Copy them to the VPS: use `scp` to copy them to `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`, and run `chmod 0600` on the key.
3. Back up the Caddyfile: `cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)`.
4. Append the block above. Validate it: `docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile`.
5. Reload (graceful, no drop): `docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
6. In Cloudflare DNS, add an A record (proxied) `assessiq` → VPS IPv4 (`72.61.227.64`). Set the SSL/TLS mode for the zone to **Full (Strict)**.
7. Smoke test: `curl -I https://assessiq.automateedge.cloud/` → expect 200/301 from Caddy with `server: Caddy` and CF headers.

If validation fails, do **not** reload. Caddy keeps the old config running. Investigate, fix and validate again.

## DNS — Cloudflare

**Goal:** set the Cloudflare DNS records.

| Record | Type | Name | Value | Proxy | TTL |
| --- | --- | --- | --- | --- | --- |
| public | A | `assessiq` | `72.61.227.64` (VPS IPv4) | **Proxied (orange)** | Auto |

**Cloudflare zone settings** for `automateedge.cloud`:

- SSL/TLS encryption mode: **Full (Strict)**. This enforces a real cert at the origin (the CF Origin Cert installed in Caddy).
- Edge Certificates: Universal SSL on (covers `assessiq.*` automatically).
- Always Use HTTPS: on.
- Min TLS Version: 1.2.
- Bot Fight Mode: on (free tier).
- WAF Managed Rules: on (free tier ruleset).

Client IPs reach Caddy through the `CF-Connecting-IP` header. The global `trusted_proxies` of Caddy already lists the Cloudflare IP ranges. The rate limiter of the auth module must read the client IP from the normalized request of Caddy, NOT from the raw `X-Forwarded-For`. Confirm this in the `01-auth` middleware tests.

## Deploy key — `assessiq-vps`

**Goal:** register or check the read-only deploy key.

The VPS authenticates to GitHub with an Ed25519 deploy key at `~/.ssh/github_deploy` (read-only access to `manishjnv/assessIQ`).

| Field | Value |
| --- | --- |
| Key file | `~/.ssh/github_deploy` (private), `~/.ssh/github_deploy.pub` (public) |
| Fingerprint | `SHA256:HXZm4e6xgZjd1h++/CxJUpl8mcH4/raA1kg/Ci+peYk` |
| GitHub URL | https://github.com/manishjnv/assessIQ/settings/keys |
| SSH config stanza | `Host github.com-assessiq` → `~/.ssh/config` on the VPS |
| Access | **Read-only**. It is sufficient for `git pull`. The team intentionally did NOT grant write access |
| Added | 2026-05-03 through `gh repo deploy-key add` (RCA closure; see `docs/RCA_LOG.md` 2026-05-03) |

**Rotation:** generate a new ed25519 key (`ssh-keygen -t ed25519 -f ~/.ssh/assessiq_deploy_new -N ''`). Add it to GitHub Settings → Deploy Keys. Update the `IdentityFile` line in `~/.ssh/config`. Verify with `ssh -T git@github.com-assessiq`. Remove the old key from GitHub, and delete the old key file.

## Public sample test demo: `/try` (apps/web, 2026-10-02)

**Goal:** change or roll back the public `/try` demo.

**What:** `/try` (SPA page, no `RequireSession`) and `/try/certificate` (static SAMPLE certificate). The content is fixed and bundled. The scoring is deterministic and runs on the client. There are **zero network requests** (no API, DB, email or AI). Code: `apps/web/src/pages/try/`. OG image: `apps/web/public/brand/social/try-og.png` (+ `.svg` source), served at `/brand/social/try-og.png`. It must NOT live under `public/try/`: a `try/` folder makes the frontend nginx treat `/try` as a directory (301 → 403). The team hit and fixed this on 2026-10-02. The marketing home links to it.

**Why not `/verify/...` for the sample certificate:** `/verify/*` is in the `@api` matcher (it goes to the API). The SPA must serve the demo page, so it lives under `/try/`.

**Edge change APPLIED 2026-10-02 (owner-approved).** The team added `/try /try/*` to the shared Caddy `@app` matcher of the `assessiq.in` block, which now reads:
```caddy
@app  path /admin /admin/* /candidate /candidate/* /take /take/* /try /try/* /assets/* /brand/*
```
Procedure: back up to `Caddyfile.bak.20261002T034840Z` next to the Caddyfile, validate in the container, do an inode-safe truncate-write (no `mv`, so the bind mount keeps its inode), and reload. The change is additive only. No other site block is touched. A mirror stays in `infra/caddyfile/assessiq.snippet`. `pnpm lint:edge-routing` needs no change (it checks Fastify mounts only). Live check: `/try` 200.

**Bug hit and fixed (RCA 2026-10-02).** The first build put the OG image in `apps/web/public/try/`. A real `try/` folder in the frontend nginx root makes `/try` a directory: 301 and then 403, so the SPA never loaded. The team fixed it in `e426760` by moving the image to `public/brand/social/try-og.png`. Rule: never create a folder under `apps/web/public/` with the name of an SPA route.

**Known limit:** the SPA serves one static `index.html`, so a shared `/try` link unfurls with the default AssessIQ OG image, because link crawlers do not run JS. To unfurl with `/brand/social/try-og.png`, give `/try` its own static HTML (or a Caddy rewrite) later.

**Rollback:** remove `/try /try/*` from `@app`. The page then returns 404 through marketing, and you should revert the home CTA.

## Marketing site: page dates and IndexNow (F1, F4 and F5, batch 8)

*History: 2026-10-02.*

**Page dates.** Sitemap `lastmod` and JSON-LD `datePublished`/`dateModified` come from `apps/marketing/src/data/page-dates.json`. The Docker build context has no `.git` (`.dockerignore`), so the build cannot compute the dates. The team generates the JSON from git history and commits it:

1. Edit a marketing page and commit it.
2. Run `node apps/marketing/scripts/page-dates.mjs` and commit the updated JSON.
3. The build fails if a sitemap URL has no entry (`astro.config.mjs` throws).

**IndexNow ping (after every marketing deploy).** Key file: `https://assessiq.in/51c5d2964f070d2482eecaaa2ef236e7.txt` (public by design). Run `node apps/marketing/scripts/indexnow-submit.mjs` from the laptop. It reads the live `sitemap-0.xml`, posts all URLs to `api.indexnow.org`, prints the HTTP status, and exits non-zero on a non-2xx response. `--dry-run` prints the payload only.

**Rejected:**

- Computing the dates at build time (no `.git` in the image).
- Adding `.git` to the build context (it is large, and it leaks history into the build).
- A new sitemap package (the inline integration exists because `@astrojs/sitemap` 3.x crashes with `trailingSlash: 'never'`).

## Deploy history

This section records every dated deploy in order. Read the table first. Each entry follows in full below the table.

| Date | HEAD sha | Scope | Migrations applied | Notes |
| --- | --- | --- | --- | --- |
| 2026-05-03 | `3ef4e25` (frontend) | Phase 1 G1.D split route and frontend | none listed | `@api` gained `/take/start` and `/help/*` |
| 2026-05-03 | not recorded | Phase 3 G3.C analytics | `0060`, `0011` re-applied | 6 new report routes, no Caddy change |
| 2026-05-03 | `b20858b` | Phase 4 embed | `0070`, `0071` and others | Embed routes, no Caddy change |
| 2026-05-08 | `e04f6e2` to `586e889` | Phase 2 AI question generator | `0016` | Skill bind mount, MCP tool |
| 2026-10-02 | `e752be6` | Batch 4 | `0132` to `0135` | Reminders job, boot rule `ORIGIN_TRUST_MODE=enforce` |
| 2026-10-02 | `27f6357` | Batch 5 | `0136`, `0138`, `0140`, `0141`, `0142` | Eval gate, `generation_batches` |
| 2026-10-02 | `c214ef1` | Batch 6 | `0143` | Help row, sections edit |
| 2026-10-02 | `05beab3` | Batch 7 | none | New mounts, harmless to old image |
| 2026-10-02 | `6336f61` | Batch 8 | `0144`, `0145` | `ordering` question type, marketing |
| 2026-10-02 | `c788ed7` | RS1 to RS5, N10 to N12 | `0146`, `0147` | Help text only, argon2 0.45.1 image |
| 2026-10-03 | `38c76e3` | RV16, N13 to N18 | `0148` | Eight page help rows |
| 2026-10-03 | `5f073f0` | Review-fix wave A | `0149`, `0150`, `0152`, `0153` | `structured_case` type |
| 2026-10-03 | `636c970` | Wave B, RV60 | `0154` | Reviewer role removed |
| 2026-10-03 | `7e2af3d` | Wave A, session q | none | FR4 embed JIT, code only |
| 2026-10-03 | `ef01da2` | Wave B, N23 to N26 | `0155` | Shared AES core |
| 2026-10-03 | `90a9ddb` | Session r | `0156` | N21 frozen question type, RV73 |
| 2026-10-09 | `4b2fe39` | Hardening S2 | `0164` | `CLAUDE_CONFIG_DIR` change (`e8c12cf`) |
| 2026-10-09 | `505031a` | Hardening S3 | `0165` | Help versions 230 to 384 |
| 2026-10-09 | `9846f05` | Hardening S4 | `0166` | Empty-state and toast text |
| 2026-10-15 | `ab729bb` | Hardening S10 | `0170`, `0171` | Tenant purge in dry-run mode |
| 2026-10-15 | `45e1ddc` | Hardening S10, second run | `0172` | Seed routes, topic focus help |
| 2026-10-16 | `b9a240b` | S10 batch 3 | `0173` to `0176` | Corrects the "third run" of 2026-10-15 |
| 2026-10-16 | `959a2b8` | S11 (RW-86/87/95/96/97/98/99) | `0177`, `0178` | New dependency `@fastify/multipart`; 39 help rows |

### Phase 1 G1.D split-route and frontend deploy (2026-05-03)

`assessiq-api` and `assessiq-frontend` are both live. The frontend container ships at SHA `3ef4e25`. It is a multi-stage Vite SPA build (apps/web) on `nginx:alpine`, with a 73.9 MB image, and it exposes host port 9091. The Caddy block does a split route. The API, embed, public-help and take/start paths reach the API container on 9092. The default route reverse-proxies to the frontend container on 9091.

**What changed 2026-05-02 (Phase 1 G1.A Session 2):** The `@api` matcher gained `/help/*`, so that the anonymous public route `GET /help/:key` of `modules/16-help-system` reaches `assessiq-api`. The route is registered without an `/api` prefix by design (an embed-friendly short URL, parallel to `/embed*`). Before the fix, `/help/...` fell through to the SPA `handle` and returned `index.html` with HTTP 200 instead of the JSON envelope. The Phase 5 deploy smoke caught it. See RCA `2026-05-02 — Caddy /help/* not forwarded`. The edit was additive only. It redirected no existing path away from anything.

**What changed 2026-05-03 (Phase 1 G1.D):** The `@api` matcher gained `/take/start` (narrowed to the exact POST path, not `/take/*`), so that `POST /take/start` (magic-link redemption) of `modules/06-attempt-engine` reaches `assessiq-api`. `GET /take/:token` intentionally falls through to the SPA. The React Router `TokenLanding` page renders for any `/take/<token>` GET, and the page of the SPA calls `POST /take/start` in the body. The Caddy container needed a restart to load the inode-preserved Caddyfile edit (see RCA `2026-05-03 — Caddy @api matcher missing /take/*`).

Live block at `/opt/ti-platform/caddy/Caddyfile`:

```caddy
# ═══ AssessIQ — assessiq.automateedge.cloud ═══
# Phase 1 G1.D: /api/* + /embed* + /help/* + /take/start → assessiq-api on 9092.
# /help/* is the anonymous embed-friendly help endpoint shipped by
# modules/16-help-system (registerHelpPublicRoutes mounts /help/:key directly,
# without the /api prefix, so embed contexts can use a short public URL —
# matches the /embed* convention for the same reason).
# /take/start is the magic-link POST endpoint (bare-root by design — short URLs
# in candidate emails). /take/:token GET intentionally falls through to the SPA
# (React Router TokenLanding renders, then POSTs /take/start).
# Default route → assessiq-frontend container on host port 9091 (live 2026-05-02).
# See docs/06-deployment.md § Reverse-proxy plan.
# Backup before any edit: /opt/ti-platform/caddy/Caddyfile.bak.<UTC-ts>.
# Edits MUST use truncate-write (cat >), NEVER mv — bind-mount inode trap
# from RCA 2026-04-30.
assessiq.automateedge.cloud {
    tls /etc/caddy/ssl/assessiq.automateedge.cloud.pem /etc/caddy/ssl/assessiq.automateedge.cloud.key
    import security-headers
    encode zstd gzip

    # API + embed + public-help + take/start routes → assessiq-api on host port 9092.
    @api path /api/* /embed* /help/* /take/start
    handle @api {
        reverse_proxy 172.17.0.1:9092 {
            header_up X-Forwarded-Proto https
        }
    }

    # Default route — assessiq-frontend container on host port 9091.
    handle {
        reverse_proxy 172.17.0.1:9091 {
            header_up X-Forwarded-Proto https
        }
    }
}
```

**What is live (verified `2026-05-01`):**

- `GET https://assessiq.automateedge.cloud/` → 200 SPA shell (`<title>AssessIQ</title>`, hashed asset `/assets/index-<hash>.js`). The SPA fallback is verified: any deep route (for example `/admin/login`, `/admin/users`, `/some-non-existent-route`) returns the same index.html, so react-router-dom can take over.
- `GET https://assessiq.automateedge.cloud/api/health` → 200 `{"status":"ok"}`. This confirms the split route and the container reachability.
- `GET https://assessiq.automateedge.cloud/help/admin.assessments.close.early?locale=en` → 200 with the JSON envelope `{key, audience, locale, shortText, longMd}`. This confirms the `/help/*` matcher addition of 2026-05-02. `GET /help/nonexistent.key` returns 404 `{"error":{"code":"NOT_FOUND",...}}` from the API (not the SPA fallback).
- `GET https://assessiq.automateedge.cloud/embed?token=...` → an exercise of the HS256-only verify path of addendum §5. `alg=none` is rejected with 401 INVALID_TOKEN. A replay is rejected with 401 INVALID_TOKEN (the Redis cache is populated).
- `GET https://assessiq.automateedge.cloud/api/auth/google/start?tenant=wipro-soc` → **401 AUTHN_FAILED `"Google SSO is not configured"`**. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are still empty (0 chars) in `/srv/assessiq/.env`. The route layer and the tenant resolution are proven correct (latency ~100 ms for the tenant DB lookup). The only remaining step is to provision the OAuth client and restart `assessiq-api`. **DEFERRED — user-side task.**
- **Cache headers:** `index.html` returns `Cache-Control: no-cache, no-store, must-revalidate` (clients receive new asset hashes after a deploy). Hashed assets (`/assets/index-<hash>.js`, `.css`) return `Cache-Control: public, max-age=31536000, immutable`.
- **Security headers (from Caddy `security-headers` snippet):** HSTS, X-Frame-Options DENY, CSP `frame-ancestors 'none'`, X-Content-Type-Options nosniff.

**Historical — Phase 0 default-route swap (resolved 2026-05-01 at SHA 3ef4e25):** Earlier in the Phase 0 closure, the default route served a `respond 200` placeholder body until the frontend container shipped. The SHA-3ef4e25 deploy log captures the swap procedure:

- a Python regex substitution against the existing `handle { ... respond 200 ... }` block;
- a truncate-write of the new Caddyfile to preserve the bind-mount inode;
- a validate-then-reload through `docker exec ti-platform-caddy-1 caddy ...`.

Later Caddyfile edits for AssessIQ should mirror that procedure.

**Historical — Phase 0 G0.A initial placeholder (resolved 2026-04-30 502 RCA):** Before the API container shipped, the entire AssessIQ block was a `respond 200` placeholder that served "We are building." That state resolved the 502 incident of 2026-04-30. The team had wired DNS and Caddy ahead of any container.

### Phase 3 G3.C analytics deploy (2026-05-03)

`assessiq-api`, `assessiq-worker` and `assessiq-frontend` are all live. Phase 3 G3.C ships 6 new admin analytics routes, the `attempt_summary_mv` materialized view and a nightly BullMQ cron refresh job.

**What changed 2026-05-03 (Phase 3 G3.C — 15-analytics):**
- Migration `0060_attempt_summary_mv.sql` applied — `attempt_summary_mv` MV created (empty, no attempt_scores yet).
- `0011_seed_help_content.sql` re-applied: 8 new analytics help keys inserted through an `ON CONFLICT DO NOTHING` upsert. (Since 2026-10-11 this file is the seed `modules/16-help-system/seeds/help_content.sql`.)
- `assessiq-api` and `assessiq-worker` containers rebuilt with new `@assessiq/analytics` package.
- 6 new routes: `GET /api/admin/reports/topic-heatmap`, `/archetype-distribution/:id`, `/cost-by-month`, `/exports/attempts.csv`, `/exports/attempts.jsonl`, `/exports/topic-heatmap.csv`. All return 401 unauthenticated (confirmed with a smoke curl).
- No Caddy config changes. All routes are under `/api/*`, which the `@api` path matcher already matches.

### Phase 4 embed deploy (2026-05-03, commit `b20858b`)

`assessiq-api`, `assessiq-worker` and `assessiq-frontend` are all live. Phase 4 ships the full embed JWT ingestion flow, admin embed origin management, the `aiq_embed_sess` cookie bridge and 4 schema migrations.

**What changed 2026-05-03 (Phase 4 — commit `b20858b`, 34 files, 1743 insertions):**

- The team applied these migrations directly to `assessiq-postgres`: `0070_embed_origins.sql` (`tenants.embed_origins TEXT[]` + GIN index), `0071_tenants_embed_metadata.sql` (`tenants.privacy_disclosed BOOLEAN` + `sessions.session_type TEXT` + index), `0072_embed_help_seed.sql` (4 help content rows for the embed surface), `0073_attempt_embed_origin.sql` (`attempts.embed_origin BOOLEAN` + partial index).
- The team rebuilt and restarted the `assessiq-api` container with the new `@assessiq/embed-sdk` package.
- New routes: `GET /embed?token=<JWT>` (full Phase 4 implementation), `GET /embed/health`, `GET /embed/sdk.js`, `POST /embed/sdk-mint` (dev-only, triple-gated by `ENABLE_EMBED_TEST_MINTER=1`), `GET /api/admin/embed-origins`, `POST /api/admin/embed-origins`, `DELETE /api/admin/embed-origins`, `DELETE /api/admin/embed-secrets/:id`, `POST /api/admin/webhook-secrets/rotate`.
- The `aiq_embed_sess` ↔ `aiq_sess` cookie bridge is active in the `onRequest` hook.
- `apps/web` gains `useEmbedMode`, `embedBus`, `EmbedLayout`, and `TakeRoot` patch for embed rendering.
- `packages/embed-sdk/` is the new public host-side npm package (`@assessiq/embed`).
- No Caddy config changes. The `@api` path matcher already matches `/embed*`.
- **Env var note:** `ENABLE_EMBED_TEST_MINTER=1` must NOT be set in production (default: unset). The triple gate (`env var + NODE_ENV != 'production' + admin session`) makes it safe to leave the variable absent.
- Smoke tests (after the deploy): `GET /api/health` → 200 ✅, `GET /embed` (no token) → 400 ✅, `GET /embed/health` → 200 ✅, `GET /embed/sdk.js` → 200 ✅, `GET /api/admin/embed-origins` (no auth) → 401 ✅.

### Phase 2 AI question generator deploy (2026-05-08)

SOC-grounded AI question generation is live. It has a 70-entry knowledge base (L1/L2/L3), the `generate-questions` Claude Code skill, the `submit_questions` MCP tool and an admin generate-drawer UI with citation chips.

**What changed 2026-05-08 (commits `e04f6e2`–`586e889`, 32 files, 2610 insertions):**
- Migration 0016 applied to `assessiq-postgres`: `questions.status` CHECK includes `'ai_draft'`; `knowledge_base_sources JSONB NOT NULL DEFAULT '[]'` added to `questions` and `question_versions`.
- `modules/04-question-bank/src/knowledge-base/`: soc-l1.json (25), soc-l2.json (25), soc-l3.json (20) KB entries.
- New route: `POST /api/admin/packs/:id/levels/:levelId/generate` (admin-only, single-flight, returns `{ questionIds, generated, skillSha }`).
- `assessiq-api` image **rebuilt** (`docker compose build assessiq-api`) and recreated.
- The `generate-questions` SKILL.md is at `prompts/skills/generate-questions/SKILL.md` (git-tracked then; bind-mounted into the container at `/home/node/.claude/skills/generate-questions/SKILL.md`).
- Admin pack-detail page: a "✦ Generate" button for each level, a slide-in drawer with a count slider and SOC topic-focus chips, and citation chips for `ai_draft` questions.
- Smoke verified: `POST /api/.../generate` (no auth) → **401** ✅

### Batch 4 deploy (2026-10-02, HEAD `e752be6`)

**Migrations applied by hand** (the same procedure as batch 2/3, before the team recreated api/worker/frontend):
- 0132: `attempt_questions.section_index`, `attempts.section_progress` (test sections, 06).
- 0133: help rows for test sections and calculator (16).
- 0134: `assessment_invitations.reminded_at` (invitation reminders, 05).
- 0135: help row `admin.assessment.reminders` (16). Help rows total 175 after this batch.

**Edge:** Caddy `@app` gained `/try /try/*` (see the `/try` section above; backup `Caddyfile.bak.20261002T034840Z`).

**New worker job: `invitation.reminders`.** It is registered as a BullMQ repeatable in `apps/api/src/worker.ts` (every 30 min, `attempts: 1`; handler `apps/api/src/jobs/invitation-reminders.ts`, logic in 05 `reminders.ts`). It is NOT an AI job. The stale-repeatable cleanup of the worker keeps it by name. Limits: 25 emails for each tick, 100 for each trailing 24 h across the platform, bulk email lane. The job does nothing unless an assessment has `settings.reminders.enabled`. Verify that the repeatable `invitation.reminders` is listed in the worker queue. Rollback: untick the setting for each assessment, or remove the registration. See `docs/plans/INVITATION_REMINDERS.md`.

**New boot requirement:** production refuses to start unless `ORIGIN_TRUST_MODE=enforce` (04 batch 4 notes). Production already runs enforce, and the team confirmed api and worker after the recreate.

**Post-deploy checks (all passed):** `/api/health` 200; `/try` 200; `POST .../finish-section` and `PATCH .../reminders` return 401 when logged out; the `invitation.reminders` repeatable is registered; 175 help rows; api and worker env `ORIGIN_TRUST_MODE=enforce`; 0 api/worker errors in logs.

### Batch 5 deploy (2026-10-02, HEAD `27f6357`; commits `21502db..27f6357`) — DONE

**Migrations applied by hand** (the same procedure as "Applying new migrations by hand", before the team recreated api/worker/frontend). All are additive:
- 0136: help rows, sections follow-ups (16).
- 0138: help rows, high-stakes grading (16).
- 0140: view `grading_override_quality` (07). It needs the roles `assessiq_app` and `assessiq_system` to exist for the GRANTs (it skips a missing role).
- 0141: help rows, eval gate (16).
- 0142: table `generation_batches` with RLS (07).
- Numbers 0137 and 0139 do not exist (skipped). Apply only the five files above.

**Before you recreate the api container** (the compose file now bind-mounts a host directory):
```bash
ssh assessiq-vps 'test -d /srv/assessiq/.git || echo "WARNING: not a git clone"'
ssh assessiq-vps 'mkdir -p /srv/assessiq/modules/07-ai-grading/eval/baselines'
```
Without `mkdir -p`, Docker creates the directory with root as owner. The mount is read-write on purpose: `bless` runs inside the api container and writes there. The directory is gitignored and survives container recreates.

**New env (api):** `AI_EVAL_GATE` (`off` | `warn` | `enforce`), default `warn` from compose. Leave it at `warn` at deploy. Do not set `enforce` until a baseline is blessed. Otherwise all AI grading returns 409 `AIG_EVAL_GATE`.

**Eval bootstrap (inside the api container, on the VPS, `/srv/assessiq`).** Run it in the container, so the skills mount and the Claude login match live grading. A host run would hash `/root/.claude/skills`, which may differ, and the gate would never match. `runs/` is container-local, so do all three steps before you recreate the container.
```bash
mkdir -p modules/07-ai-grading/eval/baselines
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts run --mode claude-code-vps
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts compare --run <ISO>
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts bless --run <ISO>
```
Only then set `AI_EVAL_GATE=enforce` in `.env` and recreate `assessiq-api`. Every later skill edit repeats run, compare and bless. The golden set is about 1 case today (N5). Grow it first for a meaningful gate.

**Deploy steps** (additive only, `assessiq-` namespace): `git pull` in `/srv/assessiq`; apply the migrations; `mkdir -p` the baselines directory; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each.

**Post-deploy checks (all passed 2026-10-02):**

- Result:
  - 5 migrations applied and recorded in `schema_migrations`.
  - The view is present, with 2 RLS policies on `generation_batches`.
  - Help rows 175 → 181.
  - No `claude` process in flight before the recreate.
  - Only `assessiq-api`, `assessiq-worker` and `assessiq-frontend` recreated. 24 containers ran before and after (neighbours untouched).
  - api/worker 0 error lines.
  - api env `AI_EVAL_GATE=warn`, `ORIGIN_TRUST_MODE=enforce`.
  - Baselines directory mounted.
- In-container gate check (a `tsx` script that calls `getEvalGateStatus()`): `{"mode":"warn","approved":false,"current":{"anchors":"30a419e9","band":"e2460dec","escalate":"ec6e9925"},"baseline_date":null}`. These are the live skill shas that the first bless must match.
- `/api/health` 200, `/try` 200; the four new routes 401 logged out.
- Super admin: `GET /api/admin/super/eval-gate` returns `mode: "warn"` and `approved: false` (until a bless). `GET /api/admin/super/grading-quality` returns 200.
- `GET /api/admin/generation-batches/active` returns `{batch:null}`, and 401 when logged out.
- `PATCH /api/admin/assessments/:id/grading` returns 401 when logged out.
- Help rows count increased (migrations 0136, 0138, 0141).

**CI side (no deploy action):** the new "Test (apps/api)" and audit steps run on GitHub. The audit shows 17 high advisories (N4).

**Rollback:**
- Code: `git checkout <previous sha>` on the VPS, rebuild and recreate api, worker, frontend.
- Migrations: they are additive. The old image ignores the table, the view and the help rows. Per-file rollback notes are in each migration header (drop `generation_batches`; drop view `grading_override_quality`).
- Gate: set `AI_EVAL_GATE=off` in `.env` and recreate `assessiq-api`.
- The baselines mount can stay.

### Batch 6 deploy (2026-10-02, HEAD `c214ef1`; commits `c1583a6..c214ef1`) — DONE

**Migrations applied by hand** (the same procedure as "Applying new migrations by hand"): 0143 only, help row `admin.assessment.sections.edit` (16). It is additive and recorded in `schema_migrations`. Help rows 181 → 182.

**Env notes:**

- `.env.example` now declares `AI_EVAL_GATE` and `AIQ_EVAL_BASELINES_DIR`. An empty `AIQ_EVAL_BASELINES_DIR=` line means unset (default `modules/07-ai-grading/eval/baselines`). Since `2c66be6`, the gate treats empty as unset. Leave it empty unless someone changes `eval/cli.ts` to honour it too (N9). The CLI always writes to `eval/baselines`.
- `ENABLE_EMBED_TEST_MINTER` is now declared in the 00-core config. It must stay unset or false in production. Blank `ENABLE_*_TEST_MINTER=` lines count as unset. The team checked the production `.env`: `NODE_ENV=production`, `ENABLE_E2E_TEST_MINTER=false`, embed flag absent.
- No other new env. `AI_EVAL_GATE` stays `warn` (no baseline is blessed yet).

**Deploy steps** (additive only, `assessiq-` namespace): `test -d /srv/assessiq/.git`; `git pull` (27f6357 → c214ef1); apply 0143; confirm that no `claude` process is in flight; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each. Dependencies changed (fastify 5.12.x, nodemailer 10), so the team rebuilt the images from the new lockfile.

**Post-deploy checks (all passed 2026-10-02):**

- 24 containers before and after; only `assessiq-api`, `assessiq-worker` and `assessiq-frontend` were recreated; api/worker 0 error lines.
- In-container versions: nodemailer 10.0.13, fastify 5.12.5.
- SMTP `transporter.verify()` OK against Brevo (no mail sent).
- `/api/health` 200, `/try` 200, `/admin` 200; a malformed JSON POST returns 400.
- Help rows 182.

**Not clicked in a browser:** Edit sections. Owner check: draft assessment → Edit sections → change → save. A published assessment shows the button disabled.

**Rollback:**

- Code: run `git checkout 27f6357` on the VPS, then rebuild and recreate api, worker and frontend.
- 0143 holds help rows only. The old image ignores them.
- Dependencies: the code checkout restores the previous lockfile. A rebuild gives the previous image (or retag the previous image).

### Batch 7 deploy (2026-10-02, HEAD `05beab3`; commits `c89b326..05beab3`) — DONE

**Migrations:** none.

**New mounts (compose, `635f3fb`):** `../modules/07-ai-grading/eval/cases-private` and `../eval/runs` are bind-mounted rw into `assessiq-api` (both gitignored). Host dirs must exist before `up`: `mkdir -p /srv/assessiq/modules/07-ai-grading/eval/{cases-private,runs,baselines}`. `eval/cli.ts` now honours `AIQ_EVAL_BASELINES_DIR` (empty = default), the same rule as `eval-gate.ts` (N9).

**NODE_ENV is required (`b7373af`, N8):** `modules/00-core/src/config.ts` has no default; boot fails if unset. Prod sets it in `.env` and the api Dockerfile `ENV`; vitest.setup sets `test`; `.env.example` has `development`. Host or laptop runs of tools (`aiq-import-pack.ts`, `cleanup-*.ts`, `migrate.ts`) now need `NODE_ENV` set (fail closed).

**Dockerignore (`05beab3`):** `.dockerignore` excludes `eval/cases-private`, `eval/runs/*/` and `eval/baselines/*.json`, so a VPS build never bakes the golden set into image layers.

**Golden set:** the 150 cases (300 files) were copied to `/srv/assessiq/modules/07-ai-grading/eval/cases-private` (chmod 700). They are never in git (owner decision: the repo is public). See `docs/05-ai-pipeline.md` § Eval golden set.

**Deploy steps** (additive only): `test -d /srv/assessiq/.git`; `git pull` (c214ef1 to 05beab3); host directories present; confirm that no `claude` process is in flight; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each. Dependencies changed (React 19.3, Vite 8, jose 6, minor group), so the team rebuilt the images from the new lockfile.

**Post-deploy checks (all passed 2026-10-02):**
- 24 containers before and after; only api, worker, frontend recreated; api/worker 0 error lines.
- `NODE_ENV=production` in the container; jose 6.2.12.
- 300 case files are visible in the container through the mount. The fresh image has NO `cases-private` (dockerignore works).
- `/`, `/admin`, `/try`, `/api/health` 200.
- The served vendor-react chunk is React 19.3.0 with no ES2021+ syntax (the pinned build target is honoured).

**Eval bootstrap (owner, N5 finish):** inside the api container, run eval run, compare and bless (commands in § Batch 5 deploy; `runs/` now survives recreates). Check that `run.json` `case_count` = 151 (150 + 1 sample). Then set `AI_EVAL_GATE=enforce` in `/srv/assessiq/.env` and recreate `assessiq-api`. A full run grades about 151 cases through Claude Code on the Max login. Expect a long run and use of the subscription quota.

**Not verified in a browser:** Edit sections hidden on a published test; candidate pages under React 19 on an older Chrome.

**Rollback:** run `git checkout c214ef1` on the VPS, then rebuild and recreate api, worker and frontend. The new mounts are harmless to the old image. There are no migrations to undo.

**Warning:** never run `git clean -fdx` on the VPS. It would delete `cases-private`, `runs` and `baselines` (all gitignored).

### Batch 8 deploy (2026-10-02, HEAD `6336f61`; commits `dcded5e..6336f61`) — DONE

**Migrations:** 0144 (`questions_type_check` adds `ordering`) and 0145 (help rows), applied by hand and recorded in `schema_migrations`. Help rows 182 to 185.

**Two stages (additive only):**

1. Marketing first, at `d0977eb`: `git pull`, build and recreate `marketing` only. 24 containers before and after, healthy. Then `node apps/marketing/scripts/indexnow-submit.mjs`: HTTP 202, 54 URLs. The live sitemap has a `lastmod` for each page (7 pages 2026-05-23, 1 page 05-24, 45 pages 10-01, 1 page 10-02; the 45 share one site-wide edit date in git).
2. Pull to `6336f61`. Confirm no `claude` process in flight (0). Apply 0144 and 0145 by hand. Build api, worker, frontend. `up -d --no-deps --force-recreate` each.

**Post-deploy checks (all passed):**
- 24 containers before and after; 0 error lines in the api logs.
- `/`, `/pricing`, `/try`, `/admin`, `/api/health`, `/take/x` return 200.
- `questions_type_check` includes `ordering`; help rows 185.
- Admin bundle contains "Move item"; the api image scorer has ordering.
- `claude` processes: 0.

**New in this batch (other sections of this file):** § Rollback and staging, § MASTER_KEY rotation (the live key is NOT rotated), § Marketing site: page dates and IndexNow. `infra/caddy/assessiq.caddy` is a reference copy only. The live file stays in `/opt/ti-platform/caddy/Caddyfile` (shared container `ti-platform-caddy-1`).

**Not verified in a browser:** the ordering question flow (author, take, score). The behavioural check is pending the operator (N12).

**Rollback:** use the code rollback procedure in § Rollback and staging with the previous SHA (`dcded5e`): rebuild and recreate api, worker, frontend and marketing. Migrations 0144 and 0145 are additive (a new CHECK value and help rows), so an older build ignores them. An older build would not render ordering questions that someone authored after the deploy.

### RS1–RS5 + N10–N12 deploy (2026-10-02, HEAD `c788ed7`; commits `274bbc6..c788ed7`)

Work in this deploy:

- Candidate-facing fixes (RS1, `0d02ea9`).
- Scenario mcq options (`ac531c5`).
- Text and brand on admin screens (RS2, `578c0aa`).
- Help text (RS3, `8113192`, `8cc46c2`).
- Docs truth pass (RS5, `f40400c`).
- argon2 0.45.1 (N10, `48e1cfb`).
- The mocked browser spec (N12, `c788ed7`).

**Migrations:** 0146 (`modules/16-help-system/migrations/0146_update_help_text_corrections.sql`) and 0147 (`0147_help_text_corrections_followup.sql`). Both change help text only. The team applied each by hand with `psql -1 -v ON_ERROR_STOP=1` and recorded it in `schema_migrations`.

- 0146 updates the global v1 row of each changed key and adds `INSERT … ON CONFLICT DO NOTHING` for it. It also inserts the 10 new keys. It is idempotent.
- 0147 corrects two rows that exist only in older module migrations (`admin.grading.rerun`, `admin.integrations.embed-origins.add`).

Help rows: 185 to 195.

#### Stage 1 — help text, candidate fixes and admin text

1. Confirm no `claude` process runs (0).
2. `git pull` on `/srv/assessiq`: `6336f61` to `8cc46c2`.
3. Apply 0146 and 0147 by hand.
4. Check: 195 help rows, 0 duplicate global keys, no tenant override rows, no row with version other than 1.
5. Run the check query. Expect 0 rows with internal words: `SELECT count(*) FROM help_content WHERE tenant_id IS NULL AND (long_md ~* '(opus|sonnet|wipro|anthropic|claude)' OR short_text ~* '(opus|sonnet|wipro|anthropic|claude)');`
6. Build `assessiq-api` and `assessiq-frontend`.
7. Recreate `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.

The team did not rebuild marketing, because marketing did not change.

**Post-deploy checks (all passed):**
- 24 containers before and after; api and frontend healthy; 0 error lines in the api and worker logs.
- `/`, `/pricing`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/api/health` and `/take/x` return 200.
- Live `index.html` links `/brand/favicon/app.webmanifest` and `https://assessiq.in/brand/social/app-og.png`.
- The manifest returns `"name": "AssessIQ"` with `application/manifest+json`. The PNG is 28,044 bytes, `image/png`.
- The live bundles contain "valid for 7 days", "Single-use link · valid 7 days", the four corrected help ids, "Plan & usage", "Where to find results", "Find your licensed sets" and "up to 1,000 rows".
- The api image has the new sanitizer lines.
- `claude` processes: 0.

**Static files of the app:** put a new static file of the web app under `/brand/` or `/assets/`. The shared Caddy `@app` matcher routes only `/admin*`, `/candidate*`, `/take*`, `/try*`, `/assets/*` and `/brand/*` to the app. A file in the `public/` root goes to the marketing site and returns 404. See `docs/08-ui-system.md`.

**Not verified in a browser on production:** the admin authoring screen for ordering questions, server scoring on a real backend, publish and the admin view. The mocked Playwright spec `apps/web/e2e/take-runner-mocked.spec.ts` covers the candidate runner only (3 tests pass). CI does not run it. The behaviour check is pending the operator.

**Rollback:** use the code rollback procedure in § Rollback and staging with the previous SHA (`6336f61`): rebuild and recreate api, worker and frontend. Migrations 0146 and 0147 change help text only and need no rollback, because an older build reads the same rows.

#### Stage 2 — API image with argon2 0.45.1

Pull `8cc46c2` to `c788ed7`. `claude` processes: 0. The team built `assessiq-api` only and recreated `assessiq-api` and `assessiq-worker` (`up -d --no-deps --force-recreate`). The team did not rebuild the frontend (no frontend change in this stage).

**Checks (all passed):**
- 24 containers before and after; api healthy; 0 error lines in the api and worker logs; `/api/health` 200.
- `argon2` in the image: `0.40.3` before, `0.45.1` after. The prebuilt glibc binary loads on `node:22-slim`. There is no Dockerfile change.
- In the container, a hash that 0.40.3 made verifies with 0.45.1, and a wrong input is rejected (the same fixture as `modules/01-auth/src/__tests__/argon2-compat.test.ts`).

**Rollback:** rebuild the api image at `8cc46c2` and recreate api and worker. Hashes that 0.45.1 made use the same algorithm and cost parameters, but the stored string lists the parameters as `m,p,t` (0.40 wrote `m,t,p`). Before a rollback, check that 0.40.3 verifies a hash that 0.45.1 made. The team did not test this direction.

### Small tasks deploy: RV16, N13 to N18 (2026-10-03, HEAD `38c76e3`; commits `62e01d8..38c76e3`)

Work in this deploy:

- Dashboard counts from the server (`511e1af`).
- Scenario answer check at save (`e6eb22d`).
- Small admin items and comment cleanup (`4ea20a8`).
- Page help for eight admin pages (`2a15ce5`).
- Astro 5 for the marketing site (`38c76e3`).

Detail for each change: `docs/plans/archive/SMALL_TASKS_N13_N18_RV16.md`.

**Migration:** 0148 (`modules/16-help-system/migrations/0148_seed_page_help.sql`). It inserts eight help rows (`<page>.page`) and changes nothing else. It is idempotent (`ON CONFLICT DO NOTHING`). The team applied it by hand with `psql -1 -v ON_ERROR_STOP=1` and recorded it in `schema_migrations`.

**Procedure (one stage, additive only):**

1. List the containers: 24 run. Confirm that no `claude` process runs (0).
2. `git pull --ff-only` on `/srv/assessiq`: `62e01d8` to `38c76e3`.
3. Apply 0148 by hand and record it. Global help rows: 195 to 203.
4. Check: 8 new page keys present, 0 duplicate global keys, 0 rows with internal words (the check query from the RS1–RS5 deploy).
5. Build `assessiq-api`, `assessiq-frontend` and `assessiq-marketing`. All three builds exit with 0. The marketing image builds with Astro 5.18.2 on `node:22`. The Dockerfile and the compose file did not change.
6. Confirm again that no `claude` process runs (0). Recreate `assessiq-api`, `assessiq-worker`, `assessiq-frontend` and `assessiq-marketing` with `up -d --no-deps --force-recreate`.

**Post-deploy checks (all passed):**
- 24 containers before and after. api, frontend and marketing are healthy. 0 error lines in the api and worker logs.
- These return 200: `/`, `/pricing`, `/contact`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/api/health`, `/take/x`, `/og/index.png` (`image/png`), `/sitemap-index.xml`, `/sitemap-0.xml` (54 URLs), `/compare/assessiq-vs-mettl`, `/tests/python`, `/robots.txt`, `/pagefind/pagefind.js`.
- Marketing: `/og/tests-python.png` is 26,350 bytes, the size from the local Astro 5 build (the Astro 4 build gave 26,374). `/contact` has the contact form and the Turnstile script.
- The served app files contain "You do not have access to this page", "Candidate details are not available", "Showing the oldest", `admin.tenant_settings` and `admin.generate_wizard`. They do not contain "pending backend enrichment" or the old help ids `admin.tenant-settings` and `admin.generate-wizard` (literal search).
- The api image has `countGradingQueue` (module 07) and `checkAnswerForSave` (module 06).
- The page lookup query (`key LIKE '<page>.%'`, audience admin, locale en, active) returns the `<page>.page` row for each of the eight pages.
- The count query runs on the production schema (all tenants, as the database owner): 2 in queue, 2 awaiting evaluation, 0 ready to publish.

**Not done:**

- No IndexNow ping. No marketing page content or page date changed. Only the build tools changed.
- No click test in a browser with an admin sign-in. `GET /api/help` and the dashboard queue need a session. The behaviour check is pending the operator: dashboard cards, the "no access" notice, the (?) help drawer on the eight pages.

**Rollback:** run `git revert` on the commit of the item, then rebuild and recreate the service. For module 06 or 07: api and worker. For admin pages: frontend. For marketing: revert `38c76e3`, then rebuild and recreate `assessiq-marketing`. Migration 0148 needs no rollback, because an older build does not read the eight rows. To remove them, delete the eight `<page>.page` keys (`tenant_id IS NULL`) and the `schema_migrations` row `0148_seed_page_help.sql`. A frontend older than `511e1af` works with the new API (it ignores `counts`). The new frontend works with an older API (it falls back to the list length).

### Review-fix deploy wave A: N20, N22, E10, RS9 (RV62, RV63, RV64), RS8 (RV58, RV59), SP7 structured_case, E9 splits, FR17 gate (2026-10-03, HEAD `5f073f0`; commits `3911f8b..5f073f0`)

Work in this deploy, in commit order:
- `fe06cd3` N22 index and migration 0150.
- `b02bbf3` N20 help ids, migration 0149 and a guard test.
- `c06516a` E10 docs.
- `afc5069` RV63: the assessment preview reads the frozen pool.
- `59a4816` FR17: the worker routes accept the super admin only.
- `5e5aaa3` RV59: the `tenant.provisioned` audit row is written in the same transaction.
- `487707d` RV58: the attempts tab "Awaiting evaluation" and a comma-separated status filter.
- `8723dc4` RV64: one shared `runGenerationPlan`.
- `b0c09fd` RV62: the topic focus reaches the runtime input.
- `a7ea234` review fixes: null-safe chunk errors, `topic_focus` of 200 characters or less with no control characters, sha de-duplication.
- `885403b`, `328dfc8`, `860bfc3` SP7: the `structured_case` question type (migrations 0152 and 0153).
- `e7d7d04` SP7 review fix: a select-one step takes one pick.
- `f5d2aa4` docs.
- `4d19c3b` E9: `04-question-bank` `service.ts` is split into `service/{_shared,packs,questions,generation}.ts`.
- `0c21079` E9: `admin-super.ts` is split into `routes/admin-super/{_shared,tenants,billing-entitlements,domains,users,entitlement-revoke}.ts`.
- `5f073f0` the audit call-site guard now expects 1.

**Migrations (four, applied by hand in this order):**
- 0149 (`modules/16-help-system/migrations/0149_rename_help_ids_page_prefix.sql`)
- 0150 (`modules/06-attempt-engine/migrations/0150_attempts_dashboard_count_idx.sql`)
- 0152 (`modules/04-question-bank/migrations/0152_question_type_structured_case.sql`)
- 0153 (`modules/16-help-system/migrations/0153_seed_structured_case_help.sql`)

Each file ran with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. The team then recorded each one with `INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (<basename>, now(), <sha256sum of the file>) ON CONFLICT DO NOTHING`.

**Pre-deploy check (read-only):** the clone is on `main` and clean at `3911f8b`. 24 containers run (6 `assessiq-*`, 18 others). Migrations are applied up to 0148 (79 rows). Global help rows: 203. Disk 54 % used. Load 0.3. Health returns 200.

**Procedure (one stage, additive only):**

1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`: `3911f8b` to `5f073f0`.
3. Confirm that no `claude` process runs (0).
4. Apply 0149, 0150, 0152 and 0153 by hand in that order, and record each one. Global help rows: 203 to 207.
5. Check the database. 13 rows are under `admin.tenant_settings.%` and `admin.question.editor.%`. The index `attempts_dashboard_count_idx` exists. `questions_type_check` includes `structured_case`.
6. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`. The build exits with 0. Use the service names with the `assessiq-` prefix. A first try with `api` and `frontend` did nothing. The team did not rebuild marketing, because it did not change.
7. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Post-deploy checks (all passed):**
- 24 containers before and after. api, worker and frontend are healthy.
- These return 200: `/`, `/pricing`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/take/x`, `/take/expired`, `/api/health`.
- `/verify/XXXX-0000-00-000000` returns 404.
- `/api/admin/worker/stats` and `/api/admin/attempts?status=submitted,auto_submitted` return 401 without a session.
- `/api/dev/mint-session` returns 404. The help API returns 401 without a session.
- 0 error lines (level 50 or 60) in the api and worker logs for 10 minutes.
- `help_content` has 207 rows. The 4 new keys are present. The old keys number 0.
- The served lazy chunk `src-94kvjwDT.js` contains "Awaiting evaluation", "Structured case", `admin.tenant_settings.company_name` and `admin.question.editor.content.`. The main bundle contains `structured_case`.

**Not done:**
- No IndexNow ping. Marketing did not change.
- No click test in a browser. Behaviour check pending operator:
  1. Open Settings and the question editor. Confirm that the (?) help text loads.
  2. Create one `structured_case` question.
  3. Open the attempts page, tab "Awaiting evaluation".
  4. Preview a published assessment. Confirm that the count matches the frozen pool.
- Not in this wave: N19 (dev tools only, no production effect), RV60 (reviewer role removal, still in work) and RS11 (e2e, local and CI only).

**Rollback:** run `git revert <sha>` for the item. Then rebuild and recreate the service. For modules 04, 05, 06, 07, 09, 02, 14 and the api routes: `assessiq-api` and `assessiq-worker`. For module 10 and the web app: `assessiq-frontend`. Migration 0150: `DROP INDEX IF EXISTS attempts_dashboard_count_idx` (harmless). Migration 0152: do not revert the CHECK while a `structured_case` row exists. Migration 0149: run the reverse UPDATE of the eight keys. Migration 0153: delete the four keys. Delete the `schema_migrations` rows that you reverse.

### Review-fix deploy wave B: RV60 reviewer role removed (2026-10-03, HEAD `636c970`; commits `5f073f0..636c970`)

Work in this deploy, in commit order:
- `7accd3f` RV77: CSV export guards.
- `ac8b8cb` dev session minter fix and Vite proxy (dev only).
- `09595fa` RS11: e2e tests and the CI job (CI only).
- `4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573` RV60: the reviewer role is removed (migration 0154).
- `0efd0f9..ad4a835` N19: six commits of development-tool updates (no production effect).
- `a951e5a` lockfile from the branch tip.
- `0ef50d9` the submit action flushes the pending autosave before `POST /submit`.
- `636c970` docs and the `Adversarial-Review:` trailer.

**Migration (one, applied by hand):** 0154. The file ran with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. The team then recorded it in `schema_migrations` with the file checksum and `ON CONFLICT DO NOTHING`. Before the deploy, production had 0 reviewer users and 0 open reviewer invites.

**Procedure (one stage, additive only):** the same steps as wave A.

1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`: `5f073f0` to `636c970`.
3. Apply 0154 by hand and record it. Global help rows stay at 207.
4. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`. Both builds exit with 0.
5. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Post-deploy checks (all passed):**
- 24 containers before and after.
- These return 200: `/`, `/pricing`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/take/x`, `/api/health`.
- `/api/admin/worker/stats` returns 401 without a session. `/api/dev/mint-session` returns 404.
- 0 error lines in the api log for 3 minutes.

**Checked:** one global help row (`admin.users.role`) still contains the word "reviewer" on purpose. Its text says that there is no reviewer role. No follow-up.

**Not done:**
- Marketing is not rebuilt in either wave. No IndexNow ping.
- No click test in a browser. The behaviour check is pending the operator: the Settings (?) help, the question editor with a structured case, the attempts tab "Awaiting evaluation", and the preview of a published assessment.

**Rollback:** run `git revert` on the commits of RV60, then rebuild and recreate `assessiq-api`, `assessiq-worker` and `assessiq-frontend`. Migration 0154: read the file first, reverse its statements by hand, and delete its `schema_migrations` row.

### Review-fix deploy wave A (session q): RS10, FR2, FR4, FR13, FR25, RS4 code, N23 to N26 (2026-10-03, HEAD `7e2af3d`)

Work in this wave: `e645d81` (CI only), `9a111e1` (FR2 `onCommit`, module 02 and 14), `eafeeac` and `7e2af3d` (FR4 embed JIT), `6638494` (FR13 web), `b5fa76a` (FR25 modules 04 and 08), `9b541ba` (RS4, marketing: not built). No migration.

**Procedure (additive only, no migration):**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker assessiq-frontend`.
4. Run `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Result:** the team recreated the three services, and they are healthy. 8 routes return the expected status.
**Not in this wave:** the marketing container (RS4 text waits for owner approval) and the IndexNow ping.
**Rollback:** run `git revert <sha>` for the item, then rebuild and recreate the same three services.

### Review-fix deploy wave B: N23, N24, N25, N26 (2026-10-03, HEAD `ef01da2`, deployed at `ef01da2`)

Work in this wave: `4ad6cc0` (N23, migration 0155, help seed), `00a951e` (N25), `f1c0aa0` (N26), `34abc0e`, `c58438a`, `9b585a7` (N24: shared AES core and Lua script), merges `54557e9` and `ef01da2`.

**Migration (one, applied by hand, as in the earlier waves):** 0155 (`modules/16-help-system/migrations/0155_help_ids_page_prefix_n23.sql`). It only renames and copies `help_content` keys. There is no schema change. Run it with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. Then record it in `schema_migrations` with the file checksum and `ON CONFLICT DO NOTHING`. Global help rows go from 200 to 203.

**Procedure:**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Apply 0155 by hand and record it.
4. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker assessiq-frontend`.
5. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**N24 note.** The stored layouts of encrypted values are unchanged, so no data migration and no re-encryption run. A rollback of the code needs no data step.

**Result:** **Wave B result (verified 2026-10-03):** the clone is at `ef01da2`. The team applied migration 0155 by hand (`psql -1 -v ON_ERROR_STOP=1`) and recorded it in `schema_migrations` with its sha256. Old keys left: 0. Global help rows: 210. The team rebuilt and recreated api, worker and frontend. The api is healthy. 0 error lines in the api and worker logs. Routes: / 200, /api/health 200, /admin/login 200, /take/x 200, /api/auth/whoami 401, /embed?token=x 401. CI is green on `ef01da2` (quality + e2e).

**Rollback:** run `git revert` on the commits, then rebuild and recreate the three services. For 0155: read the file, then reverse the renames by hand (the old keys never loaded text).

### Deploy 2026-10-03 (session r): FU-B6, FU-C17, N21, RV71 to RV74, N3, E4, RS4/PT1 marketing (HEAD `90a9ddb`)

Work in this deploy: `f9473d5` (RV27), `67919ce` (page dates), `e11cb5b` (PT1-6 terms section 7), `60477e0` (N3), `e65b993` and `90a9ddb` (RV73), `f0884bd` (FU-C17), `28ab66f` and `5b02fa1` (FU-B6), `74f1f46`, `ea906d4` (RV71, RV74), `94fdc4a` (N21, migration 0156), `9084a53`, `6ed8ded`.

**Marketing.** The team rebuilt the `assessiq-marketing` container twice: after RV27, then after PT1-6. After each build, the IndexNow ping returned HTTP 200 for 42 URLs. The sitemap has 42 URLs because the 12 coming-soon pages are `noindex` since RS4.

**Migration (one, applied by hand).** `0156` (`modules/04-question-bank/migrations/0156_question_versions_type_n21.sql`) ran with `psql -1 -v ON_ERROR_STOP=1`. It is recorded in `schema_migrations` with its sha256. Result: 169 `question_versions` rows, 0 NULL types, 0 type mismatches.

**Procedure.**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Apply 0156 by hand and record it.
4. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`.
5. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Result (verified 2026-10-03).** VPS at `90a9ddb`. 24 containers before and after. `/` 200, `/api/health` 200, `/admin/login` 200, `/take/x` 200, `/api/auth/whoami` 401, `/embed?token=x` 401, `/terms` 200. 0 error lines in the api and worker logs.

**Skill deploy (E4/G4).** `generate-subjective/SKILL.md` version `2026-10-03a`, deployed by `scp` (see 05). Backup `/root/assessiq-skills-backup-20261003/`.

**Not deployed or not run.** The RV73 backup check is NOT installed (steps below). The team did NOT run the FU-C17 audit: `ssh assessiq-vps 'docker exec assessiq-api pnpm exec tsx tools/audit-rubrics.ts'` (read-only). There is no offsite backup (R8).

**Rollback.**
- Code: `git revert <sha>`, then rebuild and recreate the three services.
- Migration 0156 (only before any code depends on it): `DROP TRIGGER question_versions_default_type ON question_versions;` `DROP FUNCTION question_versions_default_type();` `ALTER TABLE question_versions DROP CONSTRAINT question_versions_type_check;` `ALTER TABLE question_versions DROP COLUMN type;` then delete the `0156` row in `schema_migrations`. If the `94fdc4a` code runs, revert the code first.
- Skill: copy the backup file back and restart api and worker.
- Marketing: revert the commit, rebuild `assessiq-marketing`, send IndexNow again.

### Hardening S2 deploy (2026-10-09)

**What changed.** Commit `4b2fe39` (RW-7, RW-8, RW-9) and commit `e8c12cf` (RW-11). Both are pushed. The VPS is at `e8c12cf`.

#### Deploy of `4b2fe39`

1. `git pull` in `/srv/assessiq`.
2. Apply migration 0164 by hand (`psql -1`). Record it in `schema_migrations` with its sha256. It adds the help rows for the evaluation runtime chip (global help rows +1).
3. Build `assessiq-api`, `assessiq-worker` and `assessiq-frontend`.
4. Recreate each one with `up -d --no-deps --force-recreate`.

**Result.** No claude process was in flight before the recreate. 24 containers before and after. 0 error lines in the api and worker logs. `/api/health` 200, `/api/ready` 200, `/admin/login` 200. Live check: `https://assessiq.in/api/ready` returns `200 {"status":"ready","checks":{"db":true,"redis":true,"claude":true}}`.

**Redis is now required for AI.** `single-flight.ts` fails closed with `503 AIG_LOCK_UNAVAILABLE` when Redis is down. If AI calls return this 503, check `docker ps` for `assessiq-redis` and `/api/ready` first. The Redis `mem_limit` is still 256m (see SESSION_STATE open questions). Details: `docs/05-ai-pipeline.md` D7.

**Not included.** No abort of a running claude subprocess when the lease is lost. No lock on the rubric-draft and answer-guidance-draft calls. No uptime monitor yet (B2: owner signup). RW-10 (eval bless and `AI_EVAL_GATE=enforce`) is NOT done. It waits for the owner to run the eval (about 151 cases).

**Rollback of `4b2fe39`.** Run `git revert 4b2fe39`, rebuild the three services, and recreate them. Migration 0164 only adds help rows. Leave it in place.

#### RW-11: `CLAUDE_CONFIG_DIR` replaces the single-file `.claude.json` bind (`e8c12cf`)

**What.** In `infra/docker-compose.yml`, `assessiq-api` and `assessiq-worker` no longer bind `/root/.claude.json:/home/node/.claude.json:rw`. Both set `CLAUDE_CONFIG_DIR=/home/node/.claude`. The claude CLI now reads `$CLAUDE_CONFIG_DIR/.claude.json`, which sits inside the existing `/root/.claude` directory mount.

**Why.** A single-file bind follows the inode. When the host CLI rewrote `/root/.claude.json` (for example at `/login`), the container kept the old file until a restart. A directory mount shows the new file at once.

**Host steps done.**
1. Backups: `/root/.claude.json.bak-20261009` and `/root/docker-compose.yml.bak-20261009-rw11`.
2. Seed the new file: `cp -a /root/.claude.json /root/.claude/.claude.json`.
3. `up -d --no-deps --force-recreate assessiq-api assessiq-worker`.

**Verified.** Both containers healthy. 24 containers before and after. `claude mcp list` shows the `assessiq` MCP as Connected. `/home/node/.claude.json` is absent. A `claude -p` smoke test returned OK.

**New operator rule for a re-login.** The containers do NOT read the host `/root/.claude.json` any more. On the host, run `CLAUDE_CONFIG_DIR=/root/.claude claude`, then `/login`. This updates the directory copy. Credentials stay in `/root/.claude/.credentials.json` (shared). You do not need to restart the containers after a re-login.

**Rejected.** Keep the file bind and add a restart step after each login. This depends on people who remember it, and it caused the stale-file incident.

**Not included.** The team did not delete the host `/root/.claude.json`. It stays as a backup and for host-side use.

**Downstream impact.** The memory note "restart api+worker after /login" is obsolete. Any runbook that edits the host `/root/.claude.json` must edit `/root/.claude/.claude.json` instead.

**Rollback.** Restore `/root/docker-compose.yml.bak-20261009-rw11`, OR `git revert e8c12cf`. Then run `up -d --no-deps --force-recreate assessiq-api assessiq-worker`.

### Hardening S3 deploy (2026-10-09)

**What changed.** Commit `505031a` (RW-12 to RW-15: glossary, `labels.ts`, one date format, after-submit sentence). The team pushed it. The VPS is at `505031a`.

#### Deploy of `505031a`

1. Enumerate first: 24 containers, 6 `assessiq-*`, no claude process in flight, VPS clean at `e8c12cf`.
2. `git pull` in `/srv/assessiq`.
3. Apply migration 0165 by hand (`psql -1 -v ON_ERROR_STOP=1`). Record it in `schema_migrations` with its sha256. It adds new help versions (global help rows 230 to 384). `0011` is not recorded on prod, so the team did not run it again.
4. Build `assessiq-frontend` and recreate it with `up -d --no-deps --force-recreate`. Do only the frontend, because the api code did not change.

**Result.** 24 containers after. The frontend is healthy. `/`, `/admin/login`, `/candidate/login`, `/take/x`, `/api/health` and `/api/ready` all return 200. The served JS chunks contain "Grading queue", "Create organisation", "Send to organisation", "Submit assessment" and the after-submit sentence. "Release to company" and "Awaiting evaluation" are gone. The behavioural click-through is pending the owner.

**Not included.** No api or worker rebuild. The nav headers "Work" and "Content" are placeholders until RW-16. Backend API error messages keep the old words. The lint is in WARN mode (6 hits).

**Rollback.** Run `git revert 505031a`, rebuild `assessiq-frontend`, and recreate it. Migration 0165 only adds help versions. Leave it in place (the old text stays as an earlier version row).

### Hardening S4 deploy (2026-10-09)

**Scope:** Empty-state messages, error toasts and standard help text. Commit `9846f05`.

**Steps:**

1. On the VPS, run `cd /srv/assessiq && git pull` (it moves to `9846f05`).
2. Migrate: `psql -1 -v ON_ERROR_STOP=1 < infra/migrations/0166_*.sql` (record the sha256).
3. Build: `docker compose -f infra/docker-compose.yml build assessiq-frontend`
4. Recreate: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-frontend`
5. Verify: `curl -i https://assessiq.in/` (200). Spot-check `/admin/login` and `/admin/dashboard` for the empty states "No attempts." and "No results.".

**Result:** 24 containers, assessiq-frontend healthy, help rows 384 → 387 (3 new versions in 0166).

### Hardening S10 deploy (2026-10-15)

**What changed.** GitHub `main` and the VPS `/srv/assessiq` are both at `ab729bb`. The deploy has 8 commits:

- `1169f81` test guards (RW-51, RW-70, RW-71)
- `187ff35` RW-69 (erasure of AI grading data)
- `288a39b` RW-50 (difficulty warn heuristics)
- `5556e87` new audit actions
- `64cea96` RW-45 (recovery codes, two-factor reset)
- `3bf35b8` RW-47 (revoke archives clones)
- `315c18c` RW-48b (nightly tenant purge)
- `ab729bb` docs

#### Deploy steps

1. Pre-check: the VPS is a git clone, the 6 `assessiq-*` containers are healthy, and 0 grading runs are in flight.
2. Drift gate: the DB-only migrations are `0011`, `0100`, `0106` and `0109` (known). The repo-only migrations are `0170` and `0171`.
3. Apply `0170` and `0171` by hand with `psql -v ON_ERROR_STOP=1 -1`. Record both in `schema_migrations`:
   - `0170_tenant_purge.sql`, checksum `e9e464924646956226359abee0c3186a515d7b6533433ee964469d2f7fe334f8`
   - `0171_seed_rw45_account_security_help.sql`, checksum `1effa1257b767f15b00928b6a236831e4d2dd1547aa72c8a00228c812d285c0a`
4. Post-checks: `tenants_status_check` now includes `'purged'`. The 9 new help rows are present.
5. Build `assessiq-api` and `assessiq-frontend`.
6. Recreate `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.

**Result.** All 6 containers are healthy within 52 seconds. `/api/health` and `/api/ready` return 200. `https://assessiq.in/` and `/admin/account-security` return 200. The api and worker logs show no startup errors.

**The purge job is in dry-run mode.** `TENANT_PURGE_ENABLED` is NOT set in the VPS `.env`. The first tick is at 03:30 UTC. Check it with `docker logs assessiq-worker | grep tenant-purge-cron`.

**Rollback.** Run `git revert` on the commit, then rebuild and recreate the services. Migration `0170` needs no rollback, because it only widens a CHECK. The `0171` rows are inert for older builds.

### Hardening S10 deploy, second run (2026-10-15, evening)

**Commits:** `55a6891` RW-57 part 1 (seed routes), `bb5d614` RW-85, `1233c44` docs, `36cc795` RW-66, `45e1ddc` RW-46 (migration 0172). GitHub main = VPS = `45e1ddc`.
**Steps:** `git pull --ff-only`. 0 grading runs in flight. The team applied `0172_seed_rw46_topic_focus_help.sql` with `psql -v ON_ERROR_STOP=1 -1` and recorded it (checksum `7b6c07e3d6f8b4d64dc9d2e4f09efed218b7e6eaf351cba31a23af30ffec1b2a`). 1 help row is present. The team built the images assessiq-api and assessiq-frontend. The team recreated assessiq-api, assessiq-worker and assessiq-frontend with `up -d --no-deps --force-recreate`.
**Smoke:** all 6 assessiq-* containers are healthy within 50 s. /api/health 200, /api/ready 200, https://assessiq.in/ 200. No startup errors in the api log.
**Rollback:** run `git revert` on the commit, then rebuild and recreate. 0172 is one idempotent help row, inert for older builds.

### S10 batch 3 deploy (2026-10-16 02:10 IST) and a correction of the 2026-10-15 "third run"

**Correction.** The 2026-10-15 "third run" (RW-92/93) pulled `7a8ecf8` unchanged. The pushes of that evening never reached `origin/main`, because an Autopilot run had switched the local clone to `autopilot/P01-T01` (see RCA 2026-10-16). RW-92/93 went live only with this deploy.
**Commits:** `7a8ecf8..b9a240b` (21 commits; RW-53, 57 p2, 58, 63, 64, 65, 67, 86, 87, 88, 89, 90, 91, 92, 93, 94). GitHub main = VPS = `b9a240b`.
**Steps:**

1. Run `ap stop --now`.
2. Run `git merge --ff-only autopilot/P01-T01` into main, and push.
3. On the VPS, run `git pull --ff-only`. 0 grading runs were in flight.
4. Drift gate: repo-only 0173, 0174, 0175, 0176 (known DB-only 0011/0100/0106/0109).
5. The team applied the migrations in order with `psql -v ON_ERROR_STOP=1 -1` and recorded them: `0173_seed_rw57_frameworks_help.sql` b01c641079b50d8edef67f8ba9a40dc78c23ae1550df26ba62e3cb3590ca0f98 · `0174_question_imports.sql` 8d53a4c1858f5e4cda8eae501e422ae42079b87c7b85d32b03b4f2c1718d53fc · `0175_seed_rw58_question_import_help.sql` c826d0f49f8d51f667c370fde444ba411eb1d8f7a7dd879954e01eb2be1e294c · `0176_rw87_help_copy_pass.sql` d7654663518ab5c03def6d16942ac4c6ee730300be7180c4611551e5c8593269.
6. Post-checks: both import tables exist; 166 help rows at version 2.
7. The team built the images assessiq-api and assessiq-frontend (new dependency exceljs). The team recreated assessiq-api, assessiq-worker and assessiq-frontend with `up -d --no-deps --force-recreate`.

**Smoke:** all 6 assessiq-* containers are healthy within 56 s. /api/health 200, /api/ready 200, https://assessiq.in/ 200, /admin/question-import 200. No startup errors in the api or worker logs. The worker now also runs `generation-stale-sweep` every 15 min.
**Rollback:** run `git revert` on the commit, then rebuild and recreate. 0174 adds two tables and two nullable or defaulted columns (older builds ignore them). 0173, 0175 and 0176 are idempotent help rows (older builds read the older version).

### S11 deploy (2026-10-16 09:55 IST): RW-86 pages 03-13, RW-87 pass 2, RW-95, RW-96, RW-97, RW-98, RW-99

**Commits:** `3fe2746..959a2b8` (12 commits: `.agent/` gitignored, RW-98, RW-95, RW-97, RW-99, RW-86, review follow-ups, RW-87, RW-96, docs, lint fix). GitHub main = VPS `/srv/assessiq` = `959a2b8`.
**Pre-checks:** the local branch is `main`. The Autopilot process is gone (`ap status` DEAD, `.agent/STOP` kept). Push output: `3fe2746..959a2b8  main -> main`. On the VPS, `git pull --ff-only` and then `git log -1` = `959a2b8` on `main`. 0 claude processes in `assessiq-api`.
**Drift gate:** repo-only `0177`, `0178`. DB-only: the known `0011`, `0100`, `0106`, `0109`. Nothing else.
**Migrations (script `/tmp/apply-0177-0178.sh`, one transaction each, `psql -1 -v ON_ERROR_STOP=1`, recorded with sha256):** `0177_rw87_help_copy_pass_2.sql` f93880385c37c9980caf3a4a73417e4ad37f2118ee8445025bfc8bcc983e7ab5 · `0178_rw96_wizard_warnings_and_import_rubric_help.sql` e761e43fdd8016ff3449e43f5cb4b3cabfa6bdd93b466c43325efc9adf2497fe. Post-checks: all 37 `(key, version)` pairs of 0177 are present (`missing=0`). The two 0178 keys are present at version 1. Platform help rows are now 247 at v1, 173 at v2, 14 at v3. Both rows are in `schema_migrations`.
**Images:** the team built `assessiq-api` and `assessiq-frontend` (api gains `@fastify/multipart` 9.4.0). The team recreated `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.
**Smoke:** all 6 `assessiq-*` containers are healthy after 15 s. No startup errors in the api or worker logs. `/api/health` 200, `/api/ready` 200, `https://assessiq.in/` 200, `/admin/question-import` 200, `/admin/generate` 200. An unauthenticated multipart POST to `/api/admin/super/question-imports` returns 401 (the plugin is registered, and the auth chain runs first).
**Not done / follow-ups:** no seed run (production help rows come from migrations). `TENANT_PURGE_ENABLED` is still unset (dry run). RW-100 (the sentence-level STE pass on the six restructured pages) is open.
**Rollback:** run `git revert` on the commits, then rebuild and recreate. 0177/0178 are idempotent help rows (older builds read the older version). The multipart plugin only affects the import route and the body of multipart requests to other routes (400 from Zod).
**Follow-up deploy (2026-10-16 11:45 IST, `734c7ad`):** The import parser cap was still 2 MB (`IMPORT_MAX_BYTES` in `modules/04-question-bank/src/import/parse.ts`), while the route, the multipart limit and the UI said 4 MB. The team found this while it wrote the S11 owner test script. The team pulled `734c7ad`. It also brings two docs-only commits from a parallel session: roadmap consolidation `8329630` and untrack of three design docs `e8a8178`. The team rebuilt `assessiq-api` and recreated `assessiq-api` and `assessiq-worker`. 6 containers were healthy in 15 s. Health, ready and the import page returned 200. No migration.

### S12 deploy (2026-10-16 14:30 IST): batch 1 of P0-Z (Y-1, Y-4, Y-5, Y-7, RW-1, FU-B21, FU-D14, RV79, Z-2, Z-4)

**Commits:** `47d706b..78b3d83` (10 commits: Y-4, Y-5, Y-1 (0179), FU-B21, FU-D14, Y-7, Z-2, roadmap, RV79, Y-1 split into 0179/0180/0181 + email-otp fixture). GitHub main = VPS `/srv/assessiq` = `78b3d83`.
**Pre-checks:** the local branch is `main`. `.agent/STOP` is present. `ap status` DEAD. Push output: `b3bcfb4..78b3d83  main -> main`. On the VPS, `git pull --ff-only` and then `git log -1` = `78b3d83` on `main`. 0 grading runs started in the last 15 minutes. All 6 `assessiq-*` containers were healthy before the deploy. The shared containers (accessbridge, fluxpoint, foxfiber, hermes, roadmap, scopewise, ti-platform-caddy) were untouched.
**Drift gate (new reading rule, Y-7):** `>` lines = the four known DB-only names only. `<` lines = `0179_drop_reviewer_from_checks.sql`, `0180_sessions_role_check_no_reviewer.sql`, `0181_in_app_notifications_role_check_no_reviewer.sql`. Nothing else.
**Migrations (script `/tmp/apply-0179.sh`, one transaction each, `psql -1 -v ON_ERROR_STOP=1`, recorded with sha256; pre-count of reviewer rows 0|0|0):** `0179_drop_reviewer_from_checks.sql` ed7017f5843c8f0e552cd7bf2b7a6e4ea061e512da14b592f067fe95824863a1 · `0180_sessions_role_check_no_reviewer.sql` a8fe024c64ffc3ab95b2971800b0a3d6fa8cfd39f8a3a88a1d0905651ab8c424 · `0181_in_app_notifications_role_check_no_reviewer.sql` 0ec4b91189fd7c5a22b1772280dc9e4a4b12a53d1eee3e4dce0ade596874d360. Post-check: `users_role_check` and `sessions_role_check` = (admin, super_admin, candidate). `in_app_notifications_role_check` = (admin). `help_content_audience_check` is unchanged (RW-2).
**Images:** the team built `assessiq-api`. The `assessiq-frontend` build was a full cache hit (no frontend source change in this batch; the FU-D14 stories are dev-only). The team recreated `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.
**Smoke:** all 6 `assessiq-*` containers are healthy after 28 s. No startup errors in the api or worker logs. `/api/health` 200, `/api/ready` 200, `https://assessiq.in/` 200, `/admin/login` 200.
**Not done / follow-ups:** the team did not exercise the `totp_enrolled` email live (it needs a real enrolment). The owner test step is "enrol TOTP on a test admin, expect one email with the new copy". `TENANT_PURGE_ENABLED` is still unset.
**Rollback:** run `git revert` on the commits, then rebuild and recreate. 0179-0181 only narrow three CHECKs. Older builds never write `reviewer`, so the migrations need no rollback. To restore the old CHECKs by hand, add the constraints again with the `reviewer` value from 016_super_admin.sql and 0056_in_app_notifications.sql.

### S16 deploy (2026-10-17, HEAD `3ed96c1`): batch 5 of P0-Z (Z-6, Z-8, Z-12, Z-13 check, Z-15(e), Z-17, Z-21, Z-22, RW-79 tail, RW-82 tails)

*Type: reference.*

- **Pre-flight:** `/srv/assessiq` is a git clone, clean except an untracked `tools/assessiq-mcp/package-lock.json` (not ours). All 6 `assessiq-*` containers healthy. `git pull --ff-only` to `3ed96c1` (four S16 code commits `776bfa2`, `334e880`, `52c5247`, `3ed96c1` plus a roadmap commit `a70886b` from another session).
- **Drift gate:** repo-only `0192_s16_admin_guide_help.sql` and `0193_attempts_seen_at.sql`; DB-only the four known names. 165 repo files, 167 DB rows before; 169 after.
- **Migrations by hand** (script `/tmp/s16-migrate.sh`, one transaction per file, recorded with SHA256):
  - 0192 `f78040f1d376182f9b4c3f65b8908a9eda8e96ce3676fb450c59d7507528df26` — 26 help rows (`admin.guide.*` 25 + `admin.activity.page`); global active help rows 507 → 533.
  - 0193 `405d6427af2b1bd512938709e00bb0bfa4a2289bc99a67e47cecea3b16b9005d` — `attempts.seen_at timestamptz NULL`; the 4 already released attempts were backfilled as seen (0 unseen).
- **Images and containers:** `docker compose build assessiq-api assessiq-frontend` (marketing unchanged); `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`; all three healthy after 20 s.
- **Env:** no new variables. The RW-79 route needs no flag; it registers only when `apps/api/src/server.ts` injects the per-IP limiter (fail-closed).
- **Smoke:** see the S16 handoff in `docs/SESSION_STATE.md`.
- **Roll back:** `git checkout 24bd32d` + rebuild/recreate the same three services. 0192 adds help rows and 0193 adds a nullable column; both are harmless for the old code, so leave them in place.

### S15 deploy (2026-10-17 10:40 IST, HEAD `7b56890`)

*Type: reference.*

- **Pre-flight:** `/srv/assessiq` is a git clone; `git pull --ff-only` to `7b56890`; no `claude` process in flight; drift gate showed repo-only `0189_question_stats_mv.sql`, `0190_tenant_settings_result_feedback_level.sql`, `0191_s15_batch4_help.sql` and the four known DB-only names (163 repo files / 164 DB rows).
- **Migrations by hand** (script copied to `/tmp/s15-migrate.sh`, CRs stripped, run with `bash … < /dev/null`; one transaction per file; recorded in `schema_migrations` with the file SHA256):
  - 0189 `daf48338e1b5c61bf9e45b9ea9508c3acc3abdbcc770575a81e82fb8b2198db0` — materialized view `question_stats_mv` (owner `assessiq_system`, SELECT to `assessiq_app`).
  - 0190 `41b420e0341f14c6e2d2e5310653c6db77e4b488e597e3f0a719ffbca426c214` — `tenant_settings.result_feedback_level` default `none` (all 5 tenants stay `none`; owner gate).
  - 0191 `6ff735fddaf45f0e443b883c27951afdb6d1c484c7067c9c905cabf30ff9b467` — 24 help rows + rename of `admin.question_editor.negative_marks` to `admin.question.editor.negative_marks`; global active help rows 483 → 507.
  - `schema_migrations` count 164 → 167.
- **Post-checks:** `pg_matviews` has `question_stats_mv` (23 rows, 17 graded attempts); `REFRESH MATERIALIZED VIEW CONCURRENTLY question_stats_mv` ok (the nightly `analytics:refresh_mv` job now refreshes both views); the four new help keys present at version 1.
- **Images and containers:** `docker compose build assessiq-api assessiq-frontend assessiq-marketing` (marketing because Y-13 changed `search.astro`); `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend assessiq-marketing`; 6/6 healthy in 15 s.
- **Smoke (laptop → assessiq.in):** `/api/health`, `/api/ready`, `/`, `/admin/login`, `/admin/start-test`, `/candidate/progress`, `/search` 200; `/api/me/progress`, `/api/me/attempts/:id/feedback`, `/api/admin/super/questions/:id/stats`, `/api/admin/tenant-settings` 401 without a session; `/search` serves the Pagefind component UI and no `pagefind-ui.js`; 0 error lines in api and worker logs in the first 5 minutes.
- **Env:** no new environment variables. `result_feedback_level` is a DB setting per tenant (admin screen or SQL), not an env flag.
- **Roll back:** `git checkout 51677de` + rebuild/recreate the same four services; the three migrations are forward-only and harmless for the old code (an extra MV, a defaulted column, help rows), so leave them in place.

### S14 deploy (2026-10-17 03:44 IST): batch 3 of P0-Z (EX-1, EX-3, RW-59, Logo L1-L4, PT1, PT-4, P4, LC-2, S2/N2, S7/N5, RV31, Z-1, audit-export limit)

**Commits:** `48368b4..092c745` (11 commits: rate limits, LC-2 user purge, RW-59 adapters, Logo L1-L4, EX-1 + EX-3, PT1/PT-4, P4, 0187 help rows, RV31 marketing, two test-mock fixes). GitHub main = VPS `/srv/assessiq` = `092c745` (docs commits follow).
**Pre-checks:** the local branch is `main`. `.agent/STOP` is present. `ap status` DEAD. Push output: `606d15a..092c745  main -> main`. Another session committed three roadmap commits (`0b798c6`, `41c082e`, `606d15a`) on the shared clone during the session; `git pull --ff-only` on the VPS then `git log -1` = `092c745`. All 6 `assessiq-*` containers were healthy before the deploy. The shared containers were listed and not touched. The new env flags `USER_PURGE_ENABLED` and `PLAN_TIERS_ENFORCED` are declared in `.env.example` only and left unset on the VPS (= off).
**Drift gate (Y-7 reading rule):** DB-only = the four known names. Repo-only = `0183_tenant_logos.sql`, `0184_questions_negative_marks.sql`, `0185_attempt_questions_negative_marks.sql`, `0186_tenant_plans_ai_answers_override.sql`, `0187_s14_batch3_help.sql`, `0188_tenant_settings_ai_grading_scope.sql`. 160 repo files, 158 DB rows before the apply; 164 after.
**Migrations (each in one transaction, `psql -1 -v ON_ERROR_STOP=1`, recorded with sha256, in this order):**
- `0183_tenant_logos.sql` 5625366b2eab5f8f675391df38eeda9539920cba49b6ee22d240075e13c779e3 (new table + RLS; `updated_by` has no FK to `users` on purpose)
- `0184_questions_negative_marks.sql` a250398883ac58cd5137998e64e1b87c271579103cf4e18746e4a605e947f4a3 (nullable column)
- `0185_attempt_questions_negative_marks.sql` a477f951bc80e508818d2fb63895f9c8db780dd71dd21308da7acbee3a0478fa (NOT NULL DEFAULT 0; 0 rows with a non-zero value after the apply)
- `0186_tenant_plans_ai_answers_override.sql` 1ed207ee221bc9c75306cceafb5febdd8230fae8f4ae78e5aff193a40d88a843 (nullable column)
- `0187_s14_batch3_help.sql` dd4f189b91c6b18735c30c35c4a45f294c217f35a9d375924bf2db04e2c9c3ed (global active help rows 464 → 483: 19 new keys; the `admin.tenant_settings.page` v2 row was a no-op on prod)
- `0188_tenant_settings_ai_grading_scope.sql` f4cfbf82eabff59cc945b55f043090e2e7107f2ac1fe6b9cd91fa0e0b9c0be2f (NOT NULL DEFAULT 'written')
Order matters: 0186 must apply before the api restart because `getUsage` now selects the new column even with `PLAN_TIERS_ENFORCED=false`.
**Images:** the team built `assessiq-api`, `assessiq-frontend` and `assessiq-marketing` (RV31 About page), then recreated `assessiq-api`, `assessiq-worker`, `assessiq-frontend` and `assessiq-marketing` with `up -d --no-deps --force-recreate`.
**Smoke (2026-10-17 03:44 IST):** all 6 `assessiq-*` containers healthy after 26 s. No error lines in the api log; the worker ran its cron jobs normally in the first 2 minutes. `/api/health` 200 `{"status":"ok"}`, `/api/ready` 200, `https://assessiq.in/` 200, `/admin/login` 200, `/try` 200, `/about` 200 with `href="/try"`; `/api/me/notifications` 401 without a session; `/api/public/tenant-logo/<unknown uuid>` 404 and `/api/public/tenant-logo/not-a-uuid` 404; `/verify/<fake id>` 404.
**Not done / follow-ups:** no tenant has a logo yet (the owner uploads one in Settings; fresh MFA); no attempt with negative marks exists (0 rows); `user-purge-cron` runs its first dry-run tick at 03:45 UTC (read `user_purge.tick` in the worker log before flipping the flag); plan-tier gates stay off. The root `pnpm test` was run once in full (9 files failed on container start-up under load, 14 tests) and every failing or skipped DB suite was re-run green one package at a time after a local Docker clean-up; the last two test-only commits were not followed by another full run.
**Rollback:** `git revert` the commits, rebuild and recreate the four containers. Schema: 0183 (new table), 0184/0185/0186/0188 (additive columns with defaults) are safe to leave in place; 0187 adds help rows only.

### S13 deploy (2026-10-16 17:05 IST): batch 2 of P0-Z (RW-100, RW-44, RW-61, RV44/FU-B14/FU-B15, FR1/FU-B2, FR2/FU-B7, Z-3)

**Commits:** `96d798a..11d7b94` (10 commits: RW-100 docs, RW-44 review, FR1 audit export cap + archive, embed SDK build + secrets page, FU-B7 webhooks page, RW-61 tree picker, Z-3 candidate notice, 0182 help rows, docs, test-mock fix). GitHub main = VPS `/srv/assessiq` = `11d7b94`.
**Pre-checks:** the local branch is `main`. `.agent/STOP` is present. `ap status` DEAD. Push output: `b1f9b10..11d7b94  main -> main`. On the VPS, `git pull --ff-only` and then `git log -1` = `11d7b94`. All 6 `assessiq-*` containers were healthy before the deploy. The shared containers (accessbridge, fluxpoint, foxfiber, hermes, roadmap, scopewise, ti-platform-caddy) were listed and not touched. Disk 58 GB free.
**Drift gate (Y-7 reading rule):** DB-only = the four known names (`0011_seed_help_content.sql`, `0100_attempts_ai_proposals_cache`, `0106_generation_attempts_batch_id`, `0109_seed_platform_aptitude_pack.sql`). Repo-only = `0182_s13_audit_embed_webhooks_framework_help.sql`. 154 repo files, 157 DB rows before the apply.
**Migration (one transaction, `psql -1 -v ON_ERROR_STOP=1`, recorded with sha256):** `0182_s13_audit_embed_webhooks_framework_help.sql` fb9baecaffd23861b358dfe0ee2f518afb90e7231f65968842eac5734a04383c. Global active help rows 434 → 464 (31 inserts, one no-op: `admin.webhooks.events` v2 already existed from 0165). The rows `admin.audit` v2, `admin.audit.archives` v2 and `admin.audit.export.format` v3 replace the "available soon" text.
**Images:** the team built `assessiq-api` (new `apps/api/public/embed/sdk.js`, routes) and `assessiq-frontend` (admin pages, candidate shell). The team recreated `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.
**Smoke:** all 6 `assessiq-*` containers are healthy after 18 s. No errors in the api or worker logs in the first 3 minutes. `/api/health` 200, `/api/ready` 200, `https://assessiq.in/` 200, `/admin/login` 200. `/embed/sdk.js` 200 with the body `/* @assessiq/embed 1.0.0 */...`, `x-assessiq-sdk-version: 1.0.0`, `x-content-type-options: nosniff` (Cloudflare rewrites the `ETag` to a weak `-gzip` form and `cache-control` to 14400, so the API 304 path does not fire through the edge). `/api/me/notifications`, `/api/admin/audit/export.jsonl` and `/api/admin/frameworks` answer 401 without a session. `/embed?token=x` answers 401 with `frame-ancestors 'none'` AND `x-frame-options: DENY`: the shared Caddy snippet still overrides the API headers (FU-B13 owner gate, diff in `docs/SESSION_STATE.md` S13).
**Not done / follow-ups:** the Caddy change for FU-B13 (owner). No live test of the embed secrets flow (needs fresh MFA), the webhook replay or the candidate banner; the owner test list is in the S13 handoff. The root `pnpm test` was not re-run in full after the test-only commit `11d7b94`.
**Rollback:** run `git revert` on the commits, then rebuild and recreate `assessiq-api`, `assessiq-worker`, `assessiq-frontend`. 0182 adds help rows only (older builds read the older versions); no schema change to revert.
