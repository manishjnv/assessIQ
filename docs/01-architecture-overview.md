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
│                       EDGE (nginx + TLS)                             │
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
│  │  Grading Worker     │  ◀────  │  BullMQ queues (Redis)        │  │
│  │  Claude Agent SDK   │         │  grading · webhooks · email   │  │
│  └──────────┬──────────┘         └───────────────────────────────┘  │
└─────────────┼───────────────────────────────────────────────────────┘
              ▼
   ┌─────────────────────┐
   │  Anthropic API      │
   │  Sonnet · Haiku ·   │
   │  Opus               │
   └─────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          STATE LAYER                                 │
│   PostgreSQL 16 (RLS by tenant_id)   ·   Redis 7 (sessions, queue)  │
│   Object storage (uploads, exports)  — local FS first, S3-ready     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component responsibilities

### Edge — nginx
- TLS termination (Let's Encrypt via certbot, auto-renew)
- HTTP/2, gzip/brotli, basic rate limiting (per IP for `/api/auth/*`)
- Static asset caching for the SPA
- WebSocket upgrade for `/ws` (live grading-status updates)
- Reverse-proxies `/api`, `/embed`, `/ws` to the API container; everything else served as static SPA

### Frontend SPA — React 18 + Vite
- Single SPA, two route trees: `/admin/*` and `/take/*`
- Embed mode toggled via `?embed=true` — strips top nav and theme overrides applied
- Talks only to `/api/*` over fetch/WebSocket
- All UI strings keyed for i18n via `t('key')`; English ships first

### REST API — Fastify
- Stateless, horizontally scalable
- One container per role: `api` (request-serving) and `worker` (background jobs)
- Modules wire in as Fastify plugins with explicit dependency declaration
- Request flow: `nginx → fastify → auth middleware → tenant context → module handler → repository → postgres`

### Grading Worker — Claude Agent SDK
- Separate Node process; no public ports
- Subscribes to `grading:queue` in BullMQ
- For each job: pulls attempt, runs grading pipeline, writes back to DB
- Idempotent — same job can re-run safely (uses `attempt_id + prompt_version` as dedup key)
- See `docs/05-ai-pipeline.md` for the full grading flow

### State layer

**PostgreSQL 16** — single primary, daily logical backups offsite. Multi-tenant via `tenant_id` column on every domain table + Row-Level Security policies enforced via session variables.

**Redis 7** — three logical purposes:
1. Session store (admin TOTP sessions, candidate attempt sessions)
2. BullMQ queue (grading, webhooks, email)
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
[Submit] /api/attempts/:id/submit → status=submitted, enqueue grading job
   │
   ▼
[Grading worker] Pulls job → runs MCQ scoring (deterministic) + KQL pattern + AI for subjective
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
| API requests | 1 Node process per CPU core via PM2 cluster | Add API replicas behind nginx upstream |
| Grading jobs | 2 worker processes, concurrency=4 each | Scale workers horizontally; rate-limit per tenant |
| Database | Single Postgres, connection pool via PgBouncer | Read replicas for reporting queries |
| Cache | Single Redis | Redis Cluster or Sentinel for HA |
| LLM calls | Anthropic API directly | Add prompt-cache hits monitoring; consider Bedrock for cost |

The single-VPS deployment comfortably handles ~50 concurrent attempts and ~100 grading jobs/hour. That's 1000+ assessments per week — enough for SOC team plus several other internal teams.

## Security posture

- **Defense in depth:** TLS at edge, JWT for embed, session cookies for SPA (HTTP-only, Secure, SameSite=Lax), API keys for back-end calls, RLS at DB.
- **Tenant isolation:** every query carries `tenant_id`; RLS policies block cross-tenant reads even if app code has a bug.
- **Secret management:** `.env` for v1 (read-only file owned by service user); migrate to Vault/Doppler in v2.
- **Audit:** every admin action logged append-only with actor, before/after state, IP, UA. See `14-audit-log`.
- **Data residency:** Hostinger VPS region matters — for Wipro use, choose an India region (consult DPDP Act compliance).
- **AI data handling:** candidate answers are sent to Anthropic API for grading. Document this in tenant onboarding. Anthropic's data retention policy applies. For sensitive content, consider Bedrock in your own AWS account in v2.

## What's NOT in scope for v1

- On-prem deployment (Phase 4+ if a client demands it)
- BYO-LLM / model selection per tenant
- Live proctoring (webcam/screen recording — DLP nightmare)
- Mobile app (web is mobile-responsive; native app deferred)
- Real-time collaborative grading (one reviewer per attempt)
- Marketplace for question packs (single-tenant authoring only)
