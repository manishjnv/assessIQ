# Project Brain — AssessIQ

> Read at the start of every autonomous session. This file links the project's own docs; it does not copy them.
> Binding sources, in order: `CLAUDE.md` (hard rules), `PROJECT_BRAIN.md` (orientation, decision log), the module's `SKILL.md`.

## Product
AssessIQ is a multi-tenant, domain-agnostic role-readiness assessment platform: question packs, assessment cycles,
a timed candidate attempt, hybrid grading (deterministic plus admin-triggered AI), banded scoring, reports and
certificates. Three surfaces: the web app (`https://assessiq.in`), an iframe embed with a signed JWT, and a REST API
with webhooks. It is deployed and live for a university aptitude pilot; it is pre-launch with no real customer data yet.
Details: `PROJECT_BRAIN.md` § What AssessIQ is, `docs/01-architecture-overview.md`.

## Architecture
- pnpm monorepo (`pnpm-workspace.yaml`): `apps/api` (Fastify API and the BullMQ worker `src/worker.ts`),
  `apps/web` (React 19 + Vite SPA that mounts the module UIs), `apps/marketing` (standalone Astro site, outside the
  workspace), `apps/storybook`; `modules/00-core` … `modules/20-data-rights` (one domain module each; the map is in
  `PROJECT_BRAIN.md` § Module map); `packages/question-types` (type registry), `packages/http-client`, `packages/embed-sdk`.
- Storage: PostgreSQL 16 with row-level security on every tenant table; Redis 7 for sessions, rate limits, BullMQ and the AI lease.
- Migrations: `modules/<n>/migrations/NNNN_name.sql`, applied by `tools/migrate.ts`; post-migration seeds in `modules/<n>/seeds/`.
- AI: Claude Code CLI on the VPS, synchronous, started only by a super-admin click (`docs/05-ai-pipeline.md`).
  Prompts are skills on the VPS, never in git.
- Data model: `docs/02-data-model.md`. API: `docs/03-api-contract.md`. Auth: `docs/04-auth-flows.md`.
  Deployment (shared Hostinger VPS, Caddy behind Cloudflare): `docs/06-deployment.md`. Help: `docs/07-help-system.md`.
  UI: `docs/08-ui-system.md`, `docs/10-branding-guideline.md`. Observability: `docs/11-observability.md`.
  Email: `docs/13-email-system.md`. Incidents: `docs/RCA_LOG.md`. Open work: `docs/PENDING_TASKS_2026-10-01.md` § P0-W.

```layers
apps: apps/**
modules: modules/**
packages: packages/**
```
Inside `modules/`, cross-module imports are checked by `tools/lint-cross-module-deps.ts`.

## Stack & conventions
- TypeScript (ESM) on Node 22, pnpm 9. Fastify, Zod on every mutating route (`lint:route-validation`), pino through
  `streamLogger` (`tools/lint-logging-discipline.ts`), `pg` with `withTenant(tenantId, fn)` or `withSystemRole(reason, fn)`
  from `modules/02-tenancy`; raw `pool.connect()` only via `tools/pool-connect.allowlist.txt`.
- Shared helpers live in `modules/00-core` (ids, pagination, hash, csv escape; `lint:core-helpers`). Question-type
  behaviour lives in `packages/question-types` registry hooks; never add a per-type switch (`lint:question-type-registry`).
- Tests: Vitest. Root `vitest.config.ts` covers `modules/**/__tests__`, `packages/**/__tests__`, `tools/__tests__`;
  `apps/api` and `apps/web` have their own `vitest run`. DB tests start a Postgres testcontainer (Docker needed) and
  apply every migration. Lints are `tsx tools/lint-*.ts` scripts, most with a `--self-test`; `pnpm lint:repo` runs them.
- UI: build from `modules/17-ui-system` primitives (Modal, ConfirmDialog, Table, Chip, Spinner); every new UI element
  gets a `help_id` plus an entry in `modules/16-help-system/content/en/*.yml`, then `pnpm help:seed:regen`
  regenerates `modules/16-help-system/seeds/help_content.sql`. Visible words come from the labels file (`lint:ui-labels`).
- Commit messages: conventional, scoped by module number, e.g. `feat(04): …`.

## Invariants (never break)
- Tenant isolation: every domain table has `tenant_id` and an RLS policy (`lint:rls`); every endpoint runs behind the
  tenant-context middleware. Platform content (question library, frameworks) lives in the platform tenant.
- No ambient AI: no Claude call from cron, BullMQ, webhooks, candidate paths or workers (`lint:ambient-ai`).
  The Agent SDK is allowed only in `modules/07-ai-grading/runtimes/anthropic-api.ts`.
- No `if (domain === "...")` in code; domain lives in question packs. Scores are bands 0/25/50/75/100, never raw percent.
- Every admin-mutating service function writes one `audit_log` row in the same transaction via `auditInTx`.
  `audit_log` is append-only; a new action must be added to `ACTION_CATALOG` (`modules/14-audit-log/src/types.ts`) first.
- Any new personal data must be covered by `modules/20-data-rights/src/erasure.ts` in the same change.
- Load-bearing paths (high or critical risk, strict review): `modules/00-core/**`, `01-auth/**`, `02-tenancy/**`,
  `07-ai-grading/**` (and its `ci/lint-no-ambient-claude.ts`), `14-audit-log/**`, `infra/**`, Dockerfiles, compose, `.env*` templates.
- Schema change → update `docs/02-data-model.md`; API change → `docs/03-api-contract.md`; auth → `docs/04-auth-flows.md`.
- Never delete a dormant feature (Rule A) and never rename or delete an existing file. Check the older similar
  feature first (Rule B). Exam content, prompt skills, keys and `.env` files are never committed (public repo).
- Super-admin-only actions use the `superAdminOnly` pre-handler (super admin plus verified TOTP). The reviewer role is
  removed (RV60); the DB value is kept for history.

## How to run
- Install: `pnpm install --frozen-lockfile` (Node ≥ 22, pnpm 9.15).
- Typecheck: `pnpm -r typecheck`. Lint: `pnpm lint` and `pnpm lint:repo`.
- Tests: `pnpm test` (root modules, packages, tools; needs Docker for Postgres testcontainers; slow, over 5 minutes in
  full), `pnpm --filter @assessiq/api test`, `pnpm --filter @assessiq/web test`. One file: `pnpm vitest run <path>`.
- Web build: `pnpm --filter @assessiq/web build`. API locally: `pnpm --filter @assessiq/api dev` (needs `DATABASE_URL`,
  Redis and the env listed in `docs/06-deployment.md`).
- Deploys are done by the owner by hand on the shared VPS per `docs/06-deployment.md`; autonomous tasks do not deploy.
