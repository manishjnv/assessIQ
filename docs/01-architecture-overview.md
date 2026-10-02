# 01 — Architecture Overview

## System context

AssessIQ has three classes of users and three modes of access:

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CONSUMERS                                   │
│  ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐ │
│  │ Tenant Admin │   │ Candidate (SOC) │   │ Host App (embed)     │ │
│  │ (Wipro mgr)  │   │ L1/L2/L3        │   │ Wipro app / client   │ │
│  └──────┬───────┘   └────────┬────────┘   └──────────┬───────────┘ │
│         │ Browser            │ Browser              │ iframe/API   │
└─────────┼────────────────────┼──────────────────────┼──────────────┘
          ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       EDGE (Caddy + Cloudflare TLS)                         │
│      assessiq.automateedge.cloud   ·   /api   ·   /embed   ·   /ws  │
└──────────────────────────┬──────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       APPLICATION LAYER                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐│
│  │ Frontend SPA │ │  REST API    │ │ Embed Server │ │ Webhook Out ││
│  │ (React+Vite) │ │  (Fastify)   │ │ (JWT verify) │ │ (BullMQ)    ││
│  └──────────────┘ └──────┬───────┘ └──────────────┘ └─────────────┘│
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │            Domain modules (00–17)                               ││
│  │   auth · tenancy · users · question-bank · attempt-engine ...   ││
│  └────────────┬────────────────────────────────┬───────────────────┘│
│               ▼                                ▼                     │
│  ┌─────────────────────┐         ┌───────────────────────────────┐  │
│  │  Claude Code CLI    │         │  BullMQ queues (Redis)        │  │
│  │  (sync, admin click)│         │  webhooks · email · exports   │  │
│  └──────────┬──────────┘         └───────────────────────────────┘  │
└─────────────┼───────────────────────────────────────────────────────┘
              ▼
   ┌─────────────────────┐
   │ Claude (Max login)  │
   │ via CLI on the VPS  │
   │ (05-ai-pipeline)    │
   └─────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          STATE LAYER                                 │
│   PostgreSQL 16 (RLS by tenant_id)   ·   Redis 7 (sessions, queue)  │
│   Object storage (uploads, exports)  — local FS first, S3-ready     │
└─────────────────────────────────────────────────────────────────────┘
```

## Docker services (actual topology)

From `infra/docker-compose.yml`, all on network `assessiq-net`:

| Container | Role | Source |
|---|---|---|
| `assessiq-postgres` | PostgreSQL 16 (RLS by `tenant_id`) | `postgres:16-alpine` |
| `assessiq-redis` | Redis 7: sessions, rate limits, BullMQ | `redis:7-alpine` |
| `assessiq-api` | Fastify API (`tsx src/server.ts`); runs sync AI grading through the mounted `claude` CLI | `infra/docker/assessiq-api/Dockerfile` |
| `assessiq-worker` | Same image as api; `src/worker.ts` runs BullMQ jobs (non-AI) | `infra/docker-compose.yml` |
| `assessiq-frontend` | nginx serving the React SPA | `infra/docker/assessiq-frontend/Dockerfile` |
| `assessiq-marketing` | nginx serving the marketing site | `infra/docker/assessiq-marketing/Dockerfile` |

No PM2 is used. Cloudflare and the shared Caddy (`ti-platform-caddy-1`) sit in front (see `docs/06-deployment.md`).

_Last verified: 2026-10-02 against `infra/docker-compose.yml`, `infra/docker/*/Dockerfile`, `docs/05-ai-pipeline.md`, `docs/06-deployment.md`. Sections not listed (data flows, security posture, scope) were not re-verified._

## Component responsibilities

### Edge — Caddy + Cloudflare
- **Cloudflare** terminates public TLS (managed cert, WAF, rate limiting, orange-cloud proxy)
- **Caddy** (`ti-platform-caddy-1`, shared with other apps on the VPS) handles origin TLS, HTTP/2, gzip/zstd, and split-route proxying. Origin is locked to Cloudflare by Authenticated Origin Pulls (AOP, `mode require_and_verify`) plus the app-layer `x-origin-verify` header (`docs/06-deployment.md` section "Authenticated Origin Pulls (AOP)")
- Routes `/api/*`, `/embed*`, `/help/*`, `/take/start` → `assessiq-api:3000` (internal network); everything else → `assessiq-frontend:80` (host port 9091)
- WebSocket upgrade for `/ws` (live grading-status updates)
- See `docs/06-deployment.md` for the actual Caddyfile block and VPS topology

### Frontend SPA — React 19 + Vite 8
- Single SPA, two route trees: `/admin/*` and `/take/*`
- Embed mode toggled via `?embed=true` — strips top nav and theme overrides applied
- Talks only to `/api/*` over fetch/WebSocket
- All UI strings keyed for i18n via `t('key')`; English ships first

### REST API — Fastify
- Stateless, horizontally scalable
- Same image, two containers: `assessiq-api` (request-serving) and `assessiq-worker` (BullMQ scheduler and non-AI jobs, `src/worker.ts`). both bind-mount the host `claude` CLI and `/root/.claude` (`infra/docker-compose.yml`); the worker must never call it (rule: no ambient AI, enforced by `modules/07-ai-grading/ci/lint-no-ambient-claude.ts`)
- Modules wire in as Fastify plugins with explicit dependency declaration
- Request flow: `Cloudflare → Caddy → fastify → auth middleware → tenant context → module handler → repository → postgres`

### Grading Worker — Phase 1: Claude Code CLI / Phase 2: Claude Agent SDK
- **Phase 1 (current):** grading runs synchronously via Claude Code CLI on the VPS, triggered by an admin click — NOT via BullMQ. No `grading:queue` is used in Phase 1. See `docs/05-ai-pipeline.md` and `CLAUDE.md` rule #1.
- **Phase 2 (designed, not live; `AI_PIPELINE_MODE=anthropic-api`):** async BullMQ worker with the Claude Agent SDK. The SDK is allowed only in `modules/07-ai-grading/src/runtimes/anthropic-api.ts` (checked with `git grep`). Phase 1 is the live default (`claude-code-vps`, `docs/05-ai-pipeline.md` lines 11-14).
- Idempotent — same job can re-run safely (uses `attempt_id + prompt_version` as dedup key)
- See `docs/05-ai-pipeline.md` for the full grading flow and the Phase 1 → Phase 2 distinction

### State layer

**PostgreSQL 16** — single primary, daily logical backups offsite. Multi-tenant via `tenant_id` column on every domain table + Row-Level Security policies enforced via session variables.

**Redis 7** — three logical purposes:
1. Session store (admin TOTP sessions, candidate attempt sessions)
2. BullMQ queue (webhooks, email; grading queue active in Phase 2 only)
3. Rate limit counters (per IP, per tenant, per API key)

**Object storage** — local filesystem at `/var/assessiq/uploads` initially. Schema is S3-compatible; switch driver in env when migrating.

## Data flow — taking an assessment

```
Candidate clicks invite link
   │
   ▼
[Auth] Google SSO → OIDC → /api/auth/callback → session token (Redis)
   │
   ▼
[Lifecycle] /api/assessments/:id/start → creates `attempt` row, freezes question set
   │
   ▼
[Attempt engine] Candidate navigates questions, autosave every 5s to /api/attempts/:id/answer
   │
   ▼
[Submit] /api/attempts/:id/submit → status=submitted (no grading job is queued in Phase 1)
   │
   ▼
[Grading] MCQ scored deterministically; AI proposals run only when the super admin clicks grade (sync, `docs/05-ai-pipeline.md`)
   │
   ▼
[Notifications] Email candidate "submitted", admin "ready for review"
   │
   ▼
[Webhook out] If host app registered, POST signed payload to their endpoint
```

## Data flow — embed in host app

```
Host app builds JWT { tenant_id, user_id, email, assessment_id, exp }
signed with HS256 using tenant's embed secret
   │
   ▼
Host renders <iframe src="https://assessiq.automateedge.cloud/embed?token=JWT">
   │
   ▼
[Embed server] Verifies JWT signature against tenant secret, mints AssessIQ session
   │
   ▼
SPA loads in embed=true mode, runs the same attempt engine
   │
   ▼
On submit, AssessIQ posts results back to host via webhook
(host app polls /api/embed/attempts/:id for status, or registers webhook URL)
```

## Concurrency and scale model

| Concern | v1 (single VPS) | v2 (when needed) |
|---|---|---|
| API requests | One `assessiq-api` Docker container (tsx, `infra/docker/assessiq-api/Dockerfile`); no PM2 | Add API replicas behind nginx upstream |
| Grading | Sync on admin click via Claude Code CLI; single-flight; no worker queue | Phase 2 async workers (`AI_PIPELINE_MODE=anthropic-api`) |
| Database | Single Postgres, connection pool via PgBouncer | Read replicas for reporting queries |
| Cache | Single Redis | Redis Cluster or Sentinel for HA |
| LLM calls | Claude Code CLI on the VPS (Max login), not the API | Add prompt-cache hits monitoring; consider Bedrock for cost |

The single-VPS deployment comfortably handles ~50 concurrent attempts and ~100 grading jobs/hour. That's 1000+ assessments per week — enough for SOC team plus several other internal teams.

## Security posture

- **Defense in depth:** TLS at edge, JWT for embed, session cookies for SPA (HTTP-only, Secure, SameSite=Lax), API keys for back-end calls, RLS at DB.
- **Tenant isolation:** every query carries `tenant_id`; RLS policies block cross-tenant reads even if app code has a bug.
- **Secret management:** `.env` for v1 (read-only file owned by service user); migrate to Vault/Doppler in v2.
- **Audit:** every admin action logged append-only with actor, before/after state, IP, UA. See `14-audit-log`.
- **Data residency:** Hostinger VPS region matters — for Wipro use, choose an India region (consult DPDP Act compliance).
- **AI data handling:** candidate answers are sent to Claude through the Claude Code CLI for grading (Phase 1). Document this in tenant onboarding. Anthropic's data retention policy applies. For sensitive content, consider Bedrock in your own AWS account in v2.

## What's NOT in scope for v1

- On-prem deployment (Phase 4+ if a client demands it)
- BYO-LLM / model selection per tenant
- Live proctoring (webcam/screen recording — DLP nightmare)
- Mobile app (web is mobile-responsive; native app deferred)
- Real-time collaborative grading (one reviewer per attempt)
- Marketplace for question packs (single-tenant authoring only)
