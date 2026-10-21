# Deploy history 2026 — moved from docs/06-deployment.md

These dated deploy records moved out of the runbook, verbatim and in original order. `tools/docs-where.mjs` and `docs/moves.json` record the move.

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

### Z-40 step 2 deploy (2026-10-17, HEAD `c45a2eb`): Cloudflare Web Analytics on the marketing site only

**What changed in Cloudflare (zone `assessiq.in`, done from the VPS over IPv4 with the account token from the repo `.env` lines 30-34):** a Configuration Rule was created in the `http_config_settings` phase (ruleset `f1fab0134a5b418db09f1a8fc2b861d7`, rule `78e9610112b14b06b4c4ac8963d6faa0`): action `set_config`, `disable_rum: true`, expression `http.host in {assessiq.in www.assessiq.in}` and the path starts with `/admin`, `/candidate`, `/take`, `/embed` or `/api`. The zone had no configuration rules before, so nothing was overwritten. The Web Analytics site `3449b2a7f8994a63936946305901f5cd` keeps its automatic setup and its single default rule.
**Why:** Cloudflare's automatic Web Analytics was already injecting its beacon on every page of the zone, including the admin and candidate pages. Web Analytics rules could not be added (`maxRulesError`: the lite ruleset allows only its default rule). Cloudflare documents that a configuration rule with `disable_rum` overrides Web Analytics rules.
**Code:** `apps/marketing/src/pages/privacy.astro` now describes Cloudflare Web Analytics (no cookies and no browser storage per Cloudflare, raw data 7 days then aggregated, six months of history, no personal-data claim for EU and UK traffic, switched off for the app paths). Only `assessiq-marketing` was rebuilt (build exit code checked) and recreated.
**Considered and rejected:** a manual snippet in `BaseLayout.astro` (requires automatic setup off, which would also remove analytics for `scopewise.assessiq.in` on the same zone); turning the site off in the dashboard; Web Analytics path rules (limit reached).
**Verification:** with a browser user agent, `/`, `/pricing`, `/about` and `/privacy` contain `beacon.min.js`; `/admin/login`, `/admin/select-identity`, `/candidate/login`, `/take`, `/embed` do not. Live `/privacy` shows the Cloudflare text and no Clarity text. IndexNow HTTP 200 for 42 URLs. Marketing container healthy.
**Sharp edges:** the rule lives in Cloudflare, not in the repo: add this check to every post-deploy sweep (fetch `/admin/login` as a browser and grep `beacon.min.js`). An immediate re-fetch right after a container restart once showed no beacon on marketing pages for a few seconds; a repeat fetch shows it. The API token is locked to the VPS IPv4 address: call Cloudflare only from the VPS with `curl -4`.
**Rollback:** `DELETE /zones/d870db2cc7a45907c2d7b00561496f57/rulesets/f1fab0134a5b418db09f1a8fc2b861d7/rules/78e9610112b14b06b4c4ac8963d6faa0` (from the VPS), or delete the rule in the dashboard under Rules, Configuration Rules.
**Token narrowed afterwards (owner request):** the Cloudflare account token used for this change (kept in the repo `.env`, gitignored) now has only Config Settings Read and Write on the zone `assessiq.in`, usable only from the VPS IP `<ORIGIN_IP>`, expiring 2027-10-17. Tested: config rules readable; DNS, SSL, R2, Workers, API tokens and Web Analytics denied. Because it cannot read Web Analytics or edit itself, a future change that needs more access starts in the Cloudflare dashboard. The R2 keys in `.env` are unchanged.

### Z-40 step 1 deploy (2026-10-17, HEAD `9b5b23b`): Microsoft Clarity removed, marketing only

**What changed:** `apps/marketing/src/layouts/BaseLayout.astro` (Clarity snippet removed), `apps/marketing/src/pages/privacy.astro` (analytics text now says no analytics or session-recording tool runs), `src/data/page-dates.json`. Only `assessiq-marketing` was rebuilt (build exit code checked before the recreate) and recreated; api, worker, frontend, postgres and redis were not touched.
**Why:** owner chose option B on 2026-10-17: no consent banner, cookie-free analytics instead of Clarity. Clarity needs a consent signal for EEA, UK and Swiss visits and sets Microsoft cookies; the site had no banner.
**Considered and rejected:** (A) banner plus Clarity after Accept (a day of design and code, fewer recorded visits); (C) keep as is. Cloudflare automatic setup was rejected for the beacon: it injects on every page of the zone, including `/admin`, `/candidate` and `/take`, which would break the statement that no analytics runs on the app.
**Not included (step 2, waits for the owner):** the Cloudflare Web Analytics beacon. Owner steps: Cloudflare dashboard, Analytics and Logs, Web Analytics, Add a site `assessiq.in`, choose the manual JavaScript snippet (not automatic), and send the token. Claude then adds `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"..."}'>` to `BaseLayout.astro` only, rewrites the privacy sentence (Cloudflare: no cookies and no browser storage; raw data 7 days then aggregated; six months of history; its no-personal-data claim does not cover EU and UK traffic), rebuilds, refreshes page-dates and pings IndexNow. If automatic setup is already on for the zone, switch it off first.
**Verification:** `/`, `/pricing`, `/privacy`, `/about` return 200 with no `clarity.ms` or Clarity project id in the HTML; privacy text shows the new sentence and October 2026; local `pnpm build` exit 0 (build guards passed); IndexNow HTTP 200 for 42 URLs; marketing container healthy.
**Rollback:** `git revert a28e15f 9b5b23b`, rebuild `assessiq-marketing`.

### S18 follow-up deploy (2026-10-17, HEAD `f6f9232`, repo `be1d1ea`): Z-35 privacy page facts, marketing only

**What changed:** `apps/marketing/src/pages/privacy.astro` (Clarity paragraph, effective date October 2026) and `src/data/page-dates.json`. Only `assessiq-marketing` was rebuilt and recreated; api, worker, frontend, postgres and redis were not touched.
**Why:** the S18 page said aggregated data lives 13 months (no Microsoft source) and named only two Clarity cookies. Facts were checked against Microsoft Learn on 2026-10-17: playback data 30 days; click data, heatmaps and favourited sessions 9 months; sampled recordings up to 9 months; the cookie list names `_clck`, `_clsk` (first party) and CLID, ANONCHK, MR, MUID, SM (Microsoft); MUID is used for advertising, site analytics and other operational purposes; since 2025-10-31 Clarity needs a consent signal for visits from the EEA, UK and Switzerland. Cookie lifetimes are not stated by Microsoft, so the page says "about 1 year" and "about 1 day" from third-party cookie policies.
**Considered and rejected:** a consent banner now (needs a design pass and a Clarity Consent Mode call in `BaseLayout.astro`; filed as ROADMAP Z-40, owner decision).
**Verification:** live `/privacy` shows the 9-month, MUID, EEA and October 2026 text and no "13 months" or "May 2026"; `/`, `/pricing`, `/robots.txt`, `/sitemap-0.xml` return 200; sitemap `lastmod` for `/privacy` is 2026-10-17; IndexNow returned HTTP 200 for 42 URLs; marketing container healthy.
**Sharp edge:** commit `d447ef7` carried CRLF line endings for `privacy.astro` by mistake (a `-c core.autocrlf=false` commit of a CRLF working copy); `be1d1ea` restored LF with content unchanged. The image built at `f6f9232` has the same text.
**Rollback:** `git revert be1d1ea f6f9232 d447ef7` then rebuild `assessiq-marketing`.

### S18 deploy (2026-10-17, HEAD `7e1a15f`): Z-32..Z-36, EXP-1, EXP-2, EXP-4

*Type: reference.*

- **Pre-flight:** `/srv/assessiq` was a clean git clone at `802c124` (untracked `tools/assessiq-mcp/package-lock.json` is not ours). All 6 `assessiq-*` containers healthy. No Claude grading process in flight. `git pull --ff-only` to `7e1a15f` (8 commits: `daa57f6` Z-32, `59a5962` Z-33/34/35, `af0b122` Z-36, `704b47d` EXP-1, `1363645` + `b0d6363` EXP-2, `2ebfd90` EXP-4, `7e1a15f` docs).
- **Migrations by hand** (script `/tmp/s18-migrate.sh`; one transaction per file; recorded in `schema_migrations` with the SHA256):
  - 0194 `fed724560e2edccb22da78940bb3cf294d987451b73877c9589068bdfb54e65b` — table `question_source` (RLS, policies `tenant_isolation` and `tenant_isolation_insert`), four columns on `questions`, backfill. Before: 579 questions (505 active). After: 579 `question_source` rows, all `original_human` / `original`; 505 questions `review_state = 'verified'` (grandfathered, not reviewed) and 74 null.
  - 0195 `6aa42ed22e10d02bb2544defadffc6c051562977797e4670dbb6c7858d1c24eb` — 4 help rows (`admin.question_import.columns`, `.rights_status`, `.difficulty`, `.duplicates`); global active help rows 533 → 537.
  - `schema_migrations` count 169 → 171.
- **Images and containers:** `docker compose build assessiq-api assessiq-frontend assessiq-marketing`; `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend assessiq-marketing`; all healthy after 25 s. Postgres and Redis were not touched.
- **Env:** no new variables. `pg_trgm` was not installed by any migration; the import trigram check runs only if the extension already exists (it does not, so the report lists `exact` and `normalised`).
- **Smoke:** see the S18 handoff in `docs/SESSION_STATE.md`.
- **Roll back (code):** `git checkout 802c124` and rebuild/recreate the same four services. The older code does not read the new columns or table, so the migrations may stay.
- **Roll back (data, only if needed):** 0194 is forward-only. To remove it by hand: `DROP TABLE question_source;` then drop the four columns on `questions`. Do this only with the owner's approval; the old code works without it.

### S17 deploy (2026-10-17, HEAD `92d2b2e`): Z-15 (b), (d), Z-11 (c), Z-25 guard, Z-29, Z-30, safe Dependabot bumps

*Type: reference.*

- **Deployed:** `/srv/assessiq` pulled `14f689e` → `92d2b2e` (fast-forward; clean clone, 6 healthy containers before). Migration check: 0 migration files changed, so no drift step. `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker assessiq-frontend assessiq-marketing`, then `up -d --no-deps --force-recreate` for the same four. All six `assessiq-*` containers healthy after 30 s; 0 error lines in api and worker logs. The compose service names carry the `assessiq-` prefix (`api` alone fails with "no such service"; the first attempt did nothing).
- **Why api and worker were rebuilt:** the Dependabot commit changes root `pnpm.overrides` (proxy-addr, compression, body-parser, qs, ip-address and more), so the runtime dependency tree of the api and worker changed.
- **Live sweep (Haiku, 12 checks, all pass):** health and ready 200; `/admin/login`, `/candidate/login`, `/admin/guide` 200; protected routes 401; `/api/dev/mint-session` 404; marketing pages 200; sitemap 42 URLs; robots, llms.txt, og:image 200; HSTS present. The certificate-rule string sits in a lazy chunk and was not checked in the entry chunks.
- **Rollback:** `git revert` the commit range `9a5d552..8556ca8` (or only `8556ca8` for the dependency change), then rebuild and recreate the four services. Previous deployed SHA: `14f689e`.
- **Code commits on main:** `9a5d552`, `133f85c`, `258e801`, `dd3b779`, `f9c569f`, `8556ca8` (deps).
- **Frontend (needs `assessiq-frontend` rebuild):** `dd3b779` (`CandidateLogin.tsx`, mobile sign-in alignment) and `f9c569f` (`CERTIFICATE_RULE_TEXT` in `modules/11-candidate-ui`, empty Certificates page and result summary).
- **Marketing (needs `assessiq-marketing` rebuild):** `258e801` adds a build guard in `apps/marketing/astro.config.mjs`. The sitemap output is unchanged (42 URLs), so no IndexNow submission.
- **Tests only (no deploy):** `9a5d552` (print e2e wait line) and `133f85c` (blocking axe rules and 5 Linux visual baselines in `apps/web/e2e`).
- **No migrations, no new environment variables, no API change.**
- **Dependabot:** see the Dependabot line in `docs/SESSION_STATE.md`.

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

### S17 follow-up deploy (2026-10-17, HEAD `67e5db5`): Z-37 part (email label, template-sender test)

*Type: reference.*

- **Deployed:** `/srv/assessiq` pulled to `67e5db5`; `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker`, then `up -d --no-deps --force-recreate assessiq-api assessiq-worker`. Both healthy after 25 s, 0 error lines, `/api/ready` 200. No migrations, no new env variables.
- **What changed:** the meta label "Company" is now "Organisation" in 5 emails (one function, `modules/13-notifications/src/email/render.ts`). A new test fails when an email template has no sender; four unsent templates are on a named allowlist and nothing was deleted.
- **Rollback:** `git revert 67e5db5`, rebuild and recreate the same two services.



### Hotfix deploy (2026-10-18, HEAD `36d3a74`): admin blank page after login, frontend only

**What changed:** `modules/10-admin-dashboard/package.json` (`react-router-dom` `^6.27.0` to `^6.30.6`), `pnpm-lock.yaml` (one router version, 6.30.6), new guard test `tools/__tests__/single-router-copy.test.ts`. Only `assessiq-frontend` was rebuilt (build exit code checked before the recreate) and recreated; api, worker, marketing, postgres and redis were not touched. No migrations.
**Why:** the S17 Dependabot pass left the admin module on the older router, so the bundle held two router copies and `/admin` rendered blank after sign-in (RCA 2026-10-18). The S20 sweep missed it because nothing signed in.
**Considered and rejected:** rolling the frontend back to the S16 image (it still carried the same lockfile split); a pnpm `overrides` entry for the router (it hides the mismatch in package files and the next bump would split again, the guard test is the safer fix).
**Verification:** live `/admin` entry assets all load and the vendor chunk holds one router copy (the broken build held two); `/`, `/admin/login`, `/candidate/login`, `/take`, `/api/ready` return 200; no browser error entries in the API log for 5 minutes after the deploy; containers healthy. NOT verified by Claude: a signed-in render of `/admin` (no browser session available); the owner retests, and Z-47 adds an automated signed-in check.
**Rollback:** `git revert 36d3a74`, rebuild `assessiq-frontend`. This brings the blank page back, so use it only if the new build fails differently.

### S20 deploy record (2026-10-18, HEAD `bc7b335`): batch 8 (Z-7, Z-9, Z-10, Z-16, EXP-19, Z-37, EXP-5, EXP-6)

*Type: reference.*

**What changed:** `/srv/assessiq` moved from `c45a2eb` to `bc7b335` (code commits `f253297`, `e320c7f`, `e940d3b`, `c34a597`, `e92ef4b`, `75a42ca`, `8445eba`, then docs `bc7b335`). Six migrations applied by hand: 0196-0201. Rebuilt `assessiq-api` and `assessiq-frontend`; recreated `assessiq-api`, `assessiq-worker` and `assessiq-frontend`. Marketing, postgres and redis were not touched.
**Why:** the batch holds the take-page submit change, the result copy and email, the per-assessment pass mark, the takedown propagation, question search and the first exam blueprint. The new code reads the new columns, so the migrations had to land before the api restart.
**Steps and evidence:**
1. Pre-flight: clean git clone, all `assessiq-*` containers healthy, no `claude` grading process in flight.
2. `git pull --ff-only` to `bc7b335`.
3. Drift gate: exactly the 6 expected repo-only files (0196-0201); DB-only = the four known names.
4. Migrations in numeric order, one transaction each, `schema_migrations` row with the sha256 of the file:
   - 0196 `pg_trgm`, `questions.search_text`, `search_tsv`, trigger, indexes (module 04).
   - 0197 help rows for facets and search (module 16).
   - 0198 `assessments.passing_score_pct` (module 05).
   - 0199 `attempt_scores.pass_mark_pct` (module 09).
   - 0200 help rows for the pass mark (module 16).
   - 0201 `exam_blueprints` and `exam_blueprint_sections` with a seed (module 04).
5. Post-checks: `pg_trgm` installed; new columns present; blueprint seed = 1 blueprint and 4 sections; the blueprint tables have read-only policies and are owned by role `assessiq`, not `assessiq_app`; 0 questions without `search_tsv`; 0 bad pass marks; 0 scores without `pass_mark_pct`.
6. Build api and frontend: `BUILD_EXIT=0`. Then `up -d --no-deps --force-recreate` for the api, worker and frontend.
**Sweep (Haiku):** all 7 public pages 200; the 4 new or changed API routes answer 401 without a session; the bundle holds "Submit your test", "Review answers" and "Pass mark"; logs clean, restart count 0; HSTS present. The CSP header has only `frame-ancestors` (no `script-src`); filed as ROADMAP Z-46. Beacon check by hand: present on `/`, `/pricing`, `/about`, `/privacy`; absent on `/admin/login`.
**Sharp edges:**
- The first run was piped through `head` and died after the pull (SIGPIPE) with nothing else changed. Re-run with output to a file. Never pipe a deploy script through `head` or `tail`.
- The Cloudflare beacon check needs a browser User-Agent and `Accept: text/html`. Plain curl shows no beacon, which is a false FAIL.
- Never recreate `assessiq-api` or the worker while an AI grading run is in flight. Check for a `claude` process first.
**Rollback:** `git checkout c45a2eb`, rebuild `assessiq-api` and `assessiq-frontend`, recreate the same three services. The migrations are additive (new columns, tables, extension, help rows) and the old code ignores them, so leave them in place. Backout SQL is not needed. If the owner asks for it, derive it from the files: `DROP TABLE exam_blueprint_sections, exam_blueprints;` (0201); `ALTER TABLE attempt_scores DROP COLUMN pass_mark_pct;` (0199); `ALTER TABLE assessments DROP COLUMN passing_score_pct;` (0198, also drops its CHECK); for 0196 drop trigger `questions_search_text_trg`, the three indexes and the two columns on `questions`. Do not drop `pg_trgm`: the import check uses it.

## S21 deploy record (2026-10-18, batch 1)

- **Commit:** code `051f48a` (CI green: quality and e2e). Before it, `01edead` and `2ff24c9` failed CI (typecheck TS2503, then the e2e locator). Both were fixed. See RCA_LOG 2026-10-18.
- **VPS state before:** clone at `051f48a` after `git pull`, tree clean (one old untracked file, `tools/assessiq-mcp/package-lock.json`). Drift gate showed the four known DB-only names and three repo-only files (0202, two 0203).
- **Migrations applied by hand, with checksum rows (177 to 180 rows):**
  - `0202_z41_key_shortcuts_help.sql` (module 16), sha256 `298530c2...`
  - `0203_assessments_max_attempts.sql` (module 05), sha256 `36f63ff2...`
  - `0203_attempts_attempt_number.sql` (module 06), sha256 `1a0da748...`
  - Two files share the number 0203 on purpose. The lint and `tools/migrate.ts` key on the full file name.
- **Help seed:** `seeds/help_content.sql` re-applied (`ON CONFLICT DO NOTHING`): 550 to 555 rows (the five Z-39 keys).
- **Build:** `docker compose build assessiq-api assessiq-worker assessiq-frontend`, output to a file, `BUILD_EXIT=0` checked before the recreate. The worker uses the API image.
- **Recreate:** `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`. Only `assessiq-*` containers changed. Nothing was pruned.
- **Risk window:** the 0203 attempts migration swaps the unique key. The old API would fail new attempts between the migration and the recreate (about 1 minute). The site has no real candidates yet.
- **Live sweep (Haiku):** `/api/ready` 200; public pages 200; beacon on `/` and absent on `/admin/login`, `/take`, `/candidate/login`; new routes answer 401 without a session; 0 `level":50` lines in api and worker logs; new columns and help rows exist.
- **Not checked:** a signed-in `/admin` page on production. The dev session minter does not exist there, so the owner opens `/admin` and confirms. Local e2e (`signed-in-smoke.spec.ts`) passes.
- **Rollback:** previous images are not tagged. Roll back by checking out `8d6abd6` on the VPS and rebuilding. Drop the new columns only if needed: `attempts.attempt_number` (restore `UNIQUE (assessment_id, user_id)` first), `assessments.max_attempts`, `assessment_invitations.extra_attempts`.

## S21 deploy record (2026-10-18, batches 2 and 3)

- **Batch 2:** code `9be4fbd` (CI green). No migrations. Rebuilt `assessiq-api` and `assessiq-frontend`; recreated api, worker, frontend. Adds Z-23 session 1 (seven-group sidebar), the extra-attempt reason modal, take-page section grouping, and `section_names` in the attempt view. Sweep: all pass.
- **Batch 3:** code `524da5d` (CI green after one re-run of a flaky banner test, fixed in `9ae085d`). Migration `0204_z23_webhook_secret_help.sql` applied by hand (sha256 `3db9a55d...`, 181 rows in `schema_migrations`); help rows 555 to 558. Rebuilt api and frontend (`BUILD_EXIT=0` checked), recreated api, worker, frontend. Adds Z-23 session 2 (all tab strips, Webhook secret card on Webhooks), EXP-18 part 1 (publish gate), and Z-32 (`/try` prerendered head plus nginx exact-match location).
- **Z-32 test before deploy:** a local `nginx:alpine` container with the new config and the built `dist`: `nginx -t` ok; `/try` and `/try/` returned 200 with no redirect.
- **Sweep after batch 3:** `/api/ready` 200; `/`, `/try`, `/admin/login`, `/candidate/login`, `/take` all 200 with no redirect; `/try` has the title "Try a sample assessment | AssessIQ" and the canonical link `https://assessiq.in/try`; beacon on `/` and `/try`, absent on `/admin/login`, `/take`, `/candidate/login`; new routes answer 401; 0 `level":50` lines.
- **Not checked:** a signed-in `/admin` page on production. The owner opens it and confirms.
- **Rollback (batch 3):** check out `9be4fbd` on the VPS and rebuild api and frontend. Migration 0204 only inserts help rows (`ON CONFLICT DO NOTHING`); no rollback needed.

### Final deploy record

- **Commit on the VPS:** `74704fc`. The deploy used `tools/deploy.sh`.
- **What changed:**
  - The API Dockerfile (`infra/docker/assessiq-api/Dockerfile`) has a manifests stage. The install layer now depends only on the `package.json` files and the lockfile.
  - The Dockerfile uses `COPY --chown` instead of `chown -R`.
  - A local rebuild after a one-line edit fell from 11m09 to 4m01.
- **Real runs of `tools/deploy.sh`:**
  - Frontend: 2m03 (pull, build, recreate, health check, sweep, 0 fails).
  - API and worker: 1m04.
- **VPS API image build with the new Dockerfile:** 37 s. The old build took about 25 min.
- **Image check before the recreate:** the new image matches the old one for User (`root`), ports (`3000`), Entrypoint (`docker-entrypoint.sh`), Cmd (`pnpm exec tsx src/server.ts`) and WorkingDir (`/app/apps/api`). `tsx` v4.23.15 starts. 0 files have a wrong owner.
- **Z-32 production check:** `curl` shows `/try` returns 200 with no redirect, the title "Try a sample assessment | AssessIQ" and the canonical link `https://assessiq.in/try`.
- **Not checked:** a signed-in `/admin` page on production. The owner opens it and confirms (Z-47).
- **Rollback:** 1. Check out the previous commit on the VPS: `cd /srv/assessiq && git checkout <previous-sha>`. 2. Rebuild the changed services. 3. Recreate them with `up -d --no-deps --force-recreate`. No migration ran in this step.

## S22 (2026-10-18)

- Commit range: `8cd6b9d` to `0ed17887` (Z-50 migration 0205, Z-47, Z-24, Z-48, Z-39 tails, EXP-18 part 2).
- Deploy: done 2026-10-18 about 19:35 IST with tools/deploy.sh (CI check on, no bypass flag). VPS 74704fc0 -> 0c4b9ee; migration 0205 applied; help_content 558 -> 576; API, frontend and worker recreated and healthy; sweep 0 failures; extra checks: signed-in routes 401 without a session, beacon on / and absent on /admin/login and /take, 0 level-50 log lines in 5 minutes. Two earlier attempts stopped at step 1b (local e2e Postgres container stopped during seeding, a one-off Docker problem; pnpm verify:signed-in then passed 29 of 29); nothing had reached the VPS. Owner still to do: open /admin signed in and the take page once.

## Marketing site: Astro 5.18.2 to 7.4.0 (S28, 2026-10-18; NOT yet deployed)

**Goal:** close two critical Dependabot alerts (advisory GHSA-26w7-cxv4-gfx2: remote code execution when Astro's image service decodes an AVIF file) in `apps/marketing`.

**What changed** (commit `8633cd84`):
- `apps/marketing/package.json`: `astro` `^5.18.2` to `^7.4.0` (steps used: 6.4.8, then 7.4.0). The standalone lockfile `apps/marketing/pnpm-lock.yaml` changed (+787, -1655 lines).
- `apps/marketing/astro.config.mjs`: `compressHTML: true`. The Astro 7 default (`'jsx'`) removed spaces between inline elements on all 56 pages (for example "AssessIQSolutionsIT").
- `apps/marketing/src/components/Header.astro` line 6: the root page path `/index.html` maps to `/`. Astro 6+ reports `/index.html` for the root page when `build.format` is `file`, so the Home link lost `aria-current="page"`.

**Why:** the advisory is critical (CVSS 9.8). The site's code does not use `astro:assets`, `<Image>` or AVIF files, so the real exposure was low, but the alert needs closing. `sharp` was already pinned to `^0.35.5` (fix minimum 0.35.4).

**Considered and rejected:** a direct jump to 7 without the stage check (risk of a hidden break); leaving Astro 5 and dismissing the alert (leaves a critical alert open).

**Result checks:** same page count (56 HTML, 54 OG PNGs), same sitemap files (byte-identical), pagefind index present, visible text identical on all 56 pages. Left differences, not visible to users: CSS file name and size (`_astro/BaseLayout.<hash>.css`, 18.6 KB instead of 20.0 KB), minified inline script in `contact.html`, `&#38;` now written `&amp;`.

**Not included / not checked:**
- No deploy. No browser visual check. No Docker build of `infra/docker/assessiq-marketing/Dockerfile` (it uses `pnpm install --frozen-lockfile --ignore-workspace`; the same command passes locally on pnpm 9.15.0).
- Node: Astro 7.4.0 needs Node 22.22.0 or newer. The Dockerfile has `ARG NODE_VERSION=22` (latest 22.x), so it should pass; not tested.
- `@astrojs/tailwind` 6.0.2 declares peer astro ^3 to ^5. It prints a peer warning with Astro 6 and 7; build and CSS work. A replacement (Tailwind 4 / Vite plugin) is a future item.
- `pnpm audit` still shows 2 other findings (braces, postcss-selector-parser), unrelated to Astro or sharp.

**Downstream:** only the marketing container `assessiq-marketing` is affected. Deploy it with `tools/deploy.sh` as in the section above (frontend and marketing are separate from the API). No Caddy change.

**How to verify after deploy:** open `/`, `/pricing`, `/terms`, `/privacy`; check the Home link has `aria-current="page"` on `/`; check `/sitemap-0.xml` and one `/og/*.png`; run `bash tools/post-deploy-sweep.sh`.

**Rollback:** revert commit `8633cd84` (restores the old `package.json`, lockfile, config and `Header.astro`), rebuild `assessiq-marketing`.

## 2026-10-19 marketing deploy: Astro 5.18.2 to 7.4.0 (Z-38), owner "go"

**What changed.** The `assessiq-marketing` container was rebuilt from `da2a95cd` and recreated (`docker compose -f infra/docker-compose.yml build assessiq-marketing`, then `up -d --no-deps --force-recreate assessiq-marketing`). `tools/deploy.sh` does not build marketing, so this followed the manual steady-state steps above. API, worker and frontend were not touched (markers stay `9bd08797`).

**Why.** Two critical Dependabot alerts: astro below 7.2.8 (remote code execution in AVIF image optimisation). No use of that path was found in the marketing code, but the fix is the supported route.

**Checks before the deploy.** Local build with astro 7.4.0: 56 HTML files and 42 sitemap URLs, the same sitemap count as live. Visible text of `/` and `/about` matched live byte for byte. `/pricing`, `/contact` and `/privacy` differed only where Cloudflare rewrites e-mail addresses to `[email protected]` on the live site.

**Checks after.** `/`, `/about`, `/pricing`, `/contact`, `/privacy`, `/try`, `/robots.txt`, sitemap files and `/llms.txt` return 200. A missing page returns 404. Sitemap: 42 URLs. The contact page still has its form and the Turnstile widget. The post-deploy sweep showed no FAIL line. The container is healthy.

**Rollback.** The previous image is tagged `assessiq/marketing:rollback-20261019`. Run `docker tag assessiq/marketing:rollback-20261019 assessiq/marketing:latest`, then `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-marketing`.

**Considered and rejected.** Waiting for the pilot (the alert is critical); a staging copy (the local build compare covered the page set).

**Not included.** IndexNow ping (no content change); the Caddy CSP report-only line (Z-46, blocked by a permission check; see ROADMAP Z-46); marketing text about self-serve (the pricing page still says there is no self-serve sign-up, which is true until Z-71 ships).

**Downstream.** None for the app. Z-38 loses its astro item (done).

## 2026-10-19 Caddy: CSP report-only header on assessiq.in (Z-46), owner "go"

**What changed.** One line was added to the `assessiq.in { ... }` block of `/opt/ti-platform/caddy/Caddyfile` (new line 82, after `import security-headers`): `header Content-Security-Policy-Report-Only "default-src 'self'; script-src ..."`. Backup: `/opt/ti-platform/caddy/Caddyfile.bak.20261019T015310Z`. The new file was checked with `caddy validate` in the container, written in place (same inode 4194330, never `sed -i` on this single-file mount), then loaded with `caddy reload` (graceful; no restart).

**Why.** The live CSP has only `frame-ancestors`. Report-only shows in the browser console which scripts, styles and frames a stricter policy would block, so a later enforced policy does not break a page.

**Considered and rejected.** Putting the header in the shared `(security-headers)` snippet (the first repo draft did): 8 sites import it, so other apps would get a header meant for AssessIQ. The repo reference file `infra/caddy/assessiq.caddy` now matches the live placement.

**Checked after.** `https://assessiq.in/` sends both `content-security-policy: frame-ancestors 'none'` and the report-only header. `/admin/login`, `/take`, `/try`, `/api/ready` return 200. `scopesense.in` has no report-only header. Caddy stayed up.

**Rollback.** `cat /opt/ti-platform/caddy/Caddyfile.bak.20261019T015310Z > /opt/ti-platform/caddy/Caddyfile`, then `docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

**Not included.** Enforcing the policy. That waits for a clean console check on the signed-in admin, take and marketing pages (inline script and style are still allowed). Violation reports are not collected on a server; only the browser console shows them.

## Deploy record 2026-10-19 (S31): email sign-off line, test timeouts

- **What:** `bash tools/deploy.sh --yes` took the VPS from `da2a95cd` to `02500fc8`. Deployed code change: one line in the shared email footer (`modules/13-notifications`, Z-37 a). The other commits were tests, docs and the Caddy reference copy.
- **Why three services were rebuilt:** the deploy plan treats `infra/caddy/assessiq.caddy` as a shared path. The file is a repo reference copy; Caddy reads `/opt/ti-platform/caddy/Caddyfile`, so the pull changed nothing live.
- **Result:** migrations applied 0 (drift gate: repo 180, db 184, pending 0). `assessiq-api`, `assessiq-worker`, `assessiq-frontend` recreated. Sweep: 0 failures, 6 `assessiq-*` containers up, VPS commit equals `origin/main`.
- **Not changed:** Caddy, Cloudflare, DNS, flags (`PLAN_TIERS_ENFORCED`, `USER_PURGE_ENABLED`), other apps.
- **Rollback:** `ssh assessiq-vps 'cd /srv/assessiq && git checkout da2a95cd'`, rebuild the three services, `up -d --no-deps --force-recreate`.

### Z-19 flip: `USER_PURGE_ENABLED=true` and restore test (S32, 2026-10-19)

- **What changed.** `USER_PURGE_ENABLED=true` was added to `/srv/assessiq/.env` (backup `.env.bak.20261019T090102Z`, same folder). `assessiq-worker` was recreated with `up -d --no-deps --force-recreate`. It was healthy after 25 s. `docker exec assessiq-worker printenv USER_PURGE_ENABLED` prints `true`. `tools/post-deploy-sweep.sh`: 0 failures.
- **Why now.** The first tick (2026-10-19 03:45 UTC, job `user-purge-cron`) logged `dryRun: true`, `candidates: 0`. A read-only count showed 0 soft-deleted users in the whole database. So the flip could not remove anyone. The owner's rule was: flip after a dry-run tick shows only expected users.
- **Rejected.** Waiting for real soft-deleted users: the purge needs the job to run live to prove itself, and the database is empty of candidates for it. The 180-day minimum, the super-admin and platform-tenant skips and the last-admin check stay in code (`modules/03-users/src/purge.ts`).
- **Not included.** No data was purged. No code or image changed.
- **Verify.** After 2026-10-20 03:45 UTC run `ssh assessiq-vps 'docker logs assessiq-worker 2>&1 | grep user-purge-cron | tail -2'`. Expect `dryRun:false`, `purged:0`.
- **Rollback.** Set `USER_PURGE_ENABLED=false` in `.env` (or restore the backup file), then recreate `assessiq-worker`.
- **Restore test.** `bash tools/backup-restore-test.sh` passed on 2026-10-19: dump 1,775,816 bytes in under 1 s, restore in 3 s, 0 `pg_restore` errors, counts equal for tenants 6, users 12, assessments 8, attempts 6, audit_log 1067, schema_migrations 184. The temporary container, volume and dump were removed. Runbook: `docs/runbooks/backup-restore.md`. Note: a daily on-box `pg_dump` runs at 06:25 UTC into `/var/backups/assessiq/` (same disk). The weekly provider snapshot is the only off-box copy.

### S33 batch (2026-10-19, code `1e0932b2`): deploy notes and CSP enforcing steps

Status: DEPLOYED 2026-10-19 at `1eda2ec9` (code commit `1e0932b2` plus the script-location fix). `tools/deploy.sh --yes` applied 0209, 0211, 0213 and recreated api, worker and frontend, sweep 0 failures. Marketing was built and recreated by hand (`docker compose -f infra/docker-compose.yml build assessiq-marketing`, then `up -d --no-deps --force-recreate assessiq-marketing`). Live check: no inline scripts, beacon and Turnstile present.

**What ships**

- API, worker and frontend: EXP-17 routes, EXP-8 passages, Z-52 gap 5, CSP code (external scripts).
- Migrations: `0209` (module 04), `0211` (module 04), `0213` (module 06). All forward-only and idempotent. No backfill.
- Marketing: new files `font-swap.js`, `search-prefill.js`, `cost-calculator.js` and an `assetsInlineLimit: 0` build setting. Deploy by the manual marketing steps in this document, not by `tools/deploy.sh`.
- Not shipped: any Caddy change, the backup timer, any flag.

**Order**

1. Wait for a green CI on `1e0932b2`.
2. Run `tools/deploy.sh --yes` (frontend, API, worker).
3. Rebuild and swap the marketing container by the manual steps.
4. Run `bash tools/post-deploy-sweep.sh`.
5. Check one admin flow: create a question, press Verify, publish an assessment.

**Behaviour change after this deploy**

- A new question starts as `in_review`. An assessment cannot publish while a pool question is `in_review`. Old questions (NULL) are not blocked.

**CSP enforcing (separate step, needs the owner go)**

- The exact Caddy lines, the apply steps and the rollback are in `docs/design/2026-10-20-csp-enforce-plan.md`.
- Apply them only after the code above is live. Keep the report-only header in place.
- Never edit the shared `(security-headers)` snippet. Never use `sed -i` on the single-file Caddy mount.

**Off-site backup (not switched on)**

- Script `tools/backup-daily.sh`, runbook `docs/runbooks/backup-daily.md`. Nothing is installed on the VPS. Switch-on needs the owner to choose where the R2 keys live.

## Deploy record 2026-10-19 (S34): organisation upload screen, review notes, review queue

**What shipped:** VPS `1eda2ec9` to `bf07d80b`. Migration 0214 applied. `assessiq-api`, `assessiq-worker` and `assessiq-frontend` were recreated. The sweep showed 0 failures. Nothing outside the `assessiq-` namespace was touched.

**Migration 0214 (`question_review_notes`).**
- It only adds: one table, two indexes, two RLS policies (SELECT and INSERT only), one trigger. No existing row changes.
- The trigger rejects every UPDATE. It allows a DELETE only for `assessiq_system` or a superuser. The tenant purge (`modules/02-tenancy/src/purge.ts`) deletes as `assessiq_system`, so a blanket block would break it.
- The migration is idempotent. It can run twice.
- Rollback: no code path needs the table to be absent. To undo, redeploy the previous commit. Leave the table in place (forward-only rule).

**Slice tool (EXP-15).**
- `tools/exam-slice/load.mjs` calls `previewImport`, which lives in the api image. Redeploy `assessiq-api` first (done on 2026-10-19). Then the dry run works.
- The command list for the owner is in `docs/runbooks/exam-slice-spot-check.md`. Do not copy it here.
- The tool writes nothing in `--dry-run` mode. `--apply` needs a dry run of the same file in the last hour.

**Plan gate.** The Pro-only gate `question_upload` is a no-op while `PLAN_TIERS_ENFORCED` is false. No flag was flipped.

**Owner check after deploy:** open `/admin` signed in. Check the tabs Upload questions and Review queue. Mark a test question as disputed and read the note history.

## S36 deploy record (2026-10-20): Wave 1 batches A to D and credit scale x10

*Type: reference.* Five code deploys with `tools/deploy.sh --yes` (dry run first each time), plus one marketing rebuild. Sweep: 0 failures each time.

- **Migrations applied, in order.** 0215 credit ledger (19-billing); 0216 delivery_mode on assessments and invitations (05); 0217 delivery_mode, camera_enabled, readiness on attempts (06); 0218 help rows; 0219 real-only materialized views (15); 0220 help rows; 0221 sign-up claims and `tenants.self_registered` (02); 0222 counted candidates (19); 0223 legal acceptances (03); 0224 help rows; 0225 credit scale x10 (19); 0226 help versions. All additive.
- **New worker jobs (queue `assessiq-cron`, no AI).** `credit-free-refill` daily 00:10 UTC (idempotent; the first run each UTC month does the work); `credit-expire` daily 02:20 UTC.
- **New environment values.** `SIGNUP_ENABLED` (default false; OFF on the server), `TURNSTILE_SITE_KEY` (empty), `SIGNUP_TURNSTILE_HOSTNAMES` (optional). `PLAN_TIERS_ENFORCED` stays false until the pilot tenants are on a paid tier (Z-18).
- **Marketing deploy used.** On the server, in `/srv/assessiq`: `docker compose -f infra/docker-compose.yml build assessiq-marketing`, then `up -d --no-deps --force-recreate assessiq-marketing`. Only that container was recreated. Page dates came from `node apps/marketing/scripts/page-dates.mjs` committed before the build. The IndexNow ping was NOT run.
- **Read-only checks after the marketing deploy.** `/dpa`, `/terms`, `/privacy`, `/signup` answered 200; `/terms` shows "Effective date: 20 October 2026"; `GET /api/public/signup/config` answered `open:false`; `POST /api/public/signup/request` answered 404.
- **Credit scale x10 on the server.** After migration 0225: every Free tenant shows 250 included credits and a 200-credit free grant; `obj_description('credit_grants')` is "Z-95 credit scale x10 applied". Deploy-order note: migrations run before the services are recreated, so for a few minutes old code ran on scaled data (accepted before launch).
- **Pilot tenants and the flag flip (owner yes, late S36).** `tools/pilot-tenant-to-paid.sql` ran for real: birla and wipro-soc are `pro` with 4,500 credits and a 4,500-credit pilot grant each. Then `PLAN_TIERS_ENFORCED=true` was appended to `/srv/assessiq/.env` (a backup copy of the file stayed on the server) and only `assessiq-api` was recreated. Sweep 0 failures. The flag is ON. Undo: set it to false and recreate `assessiq-api`.
- **Rollback.** Revert the commits and deploy again; migrations stay. Sign-up: `SIGNUP_ENABLED=false` and recreate `assessiq-api`. Credit scale: divide credits, remaining, shortfall and included credits by 10, restore the insert policy limit 20, clear the table comment (not automatic).
- **Sign-up steps.** `docs/runbooks/open-signup.md`. Monitoring: `docs/runbooks/uptimerobot-setup.md` (three monitors Up, alert mail tested 2026-10-20).


## S37 deploy record (2026-10-20)

- Code `160e89e5` deployed with `bash tools/deploy.sh --yes` (dry run first). Migration `0227_credit_lowbalance_notices.sql` applied. Services recreated: `assessiq-api`, `assessiq-worker`, `assessiq-frontend`. Sweep: 0 failures.
- The deploy script does not rebuild `assessiq-marketing`. It was rebuilt by hand on the server: `docker compose -f infra/docker-compose.yml build assessiq-marketing`, then `up -d --no-deps --force-recreate assessiq-marketing`. Read-only curl: the four new `/resources/*` pages, `/privacy`, `/terms`, `/signup` answer 200 and the sitemap lists the new pages.
- Not run: the IndexNow ping (`node apps/marketing/scripts/indexnow-submit.mjs`).
- Owner check still open: open `/admin` signed in and one take page (router flags, step 1).
