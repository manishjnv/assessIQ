# 06 — Deployment

> **Status:** rewritten 2026-04-30 to reflect the actual VPS state. Earlier draft assumed nginx + certbot; reality is **Caddy** as the global TLS edge, **Cloudflare** in front, and **other apps already on the box** (`ti-platform`, `accessbridge`, `roadmap`).

## Target topology — actual

The shared Hostinger VPS (`srv1150121.hstgr.cloud`, alias `assessiq-vps`) runs three apps already; AssessIQ is additive. Caddy (owned by ti-platform) is the only thing bound to host ports 80/443; everything else upstreams through it. Cloudflare orange-cloud proxies the public domain.

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
- Certbot (Cloudflare manages the public cert; CF Origin Cert is for origin pull).
- Anthropic API direct calls (Phase 1 grading uses Claude Code CLI under the admin's Max account — see `docs/05-ai-pipeline.md` and `CLAUDE.md` rule #1).

## VPS layout — file paths

| Path | Owner | Purpose |
| --- | --- | --- |
| `/srv/assessiq/` | this repo | docker-compose.yml, .env, Dockerfiles, migrations seed dir |
| `/srv/assessiq/data/` | this app | bind mounts for `pgdata`, `redis-data`, `uploads/` (named volumes preferred; bind only if a host-side tool needs to read) |
| `/var/log/assessiq/` | this app | per-stream JSONL operational logs (`app.log`, `request.log`, `auth.log`, `grading.log`, `migration.log`, `webhook.log`, `frontend.log`, `error.log` mirror). Schema, redaction, retention and triage runbooks live in [docs/11-observability.md](11-observability.md) — this doc only documents disk topology. Owner `assessiq:assessiq`, mode `0750`. Bind-mounted into containers at the same host path. Rotated daily by system `logrotate` with `copytruncate` (config at `infra/logrotate.d/assessiq` — symlinked into `/etc/logrotate.d/`; see § "Log directory + rotation — apply procedure" below). |
| `/var/backups/assessiq/` | this app | nightly pg_dump destination |
| `/opt/ti-platform/caddy/Caddyfile` | **ti-platform (shared!)** | Global Caddy config; AssessIQ adds **one server block** here, never edits anything else |

**Hard rule (CLAUDE.md #8 reaffirmed):** AssessIQ's deploy diff is allowed to (a) create files under the four `assessiq`-prefixed paths above and (b) **append** one server block to the ti-platform Caddyfile. Anything else on this box is off-limits without explicit user approval.

### Log directory + rotation — apply procedure

One-time, additive on a fresh VPS or first observability-enabled deploy:

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

`copytruncate` is load-bearing — pino holds open file descriptors, and rotation without `copytruncate` results in the rotated file continuing to receive writes while the new file stays empty. Same trap class as the Caddy bind-mount inode RCA (`docs/RCA_LOG.md` 2026-04-30). See `docs/11-observability.md § 7` for the rationale and the in-config explanation.

Set `LOG_DIR=/var/log/assessiq` in `/srv/assessiq/.env` so `00-core` activates the on-disk JSONL fan-out (without it, all logs only go to stdout / Docker json-file). Restart the `assessiq-api` and `assessiq-worker` containers after first set: `docker compose -f /srv/assessiq/docker-compose.yml up -d assessiq-api assessiq-worker`.

## Reverse-proxy plan — additive Caddyfile block

The ti-platform Caddyfile (at `/opt/ti-platform/caddy/Caddyfile`) already has Cloudflare IPs in `trusted_proxies` and uses bridge-gateway upstreams (`172.17.0.1:<port>`) to reach apps on other Docker networks (this is the pattern roadmap and accessbridge use today). Match that pattern — no edits to ti-platform's `docker-compose.yml`, no `extra_hosts`, no shared-network coupling.

Block to **append** to `/opt/ti-platform/caddy/Caddyfile`:

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

1. Generate CF Origin Cert in Cloudflare dashboard (Zero Trust → Origin Server → Create Certificate, RSA 2048, 15-year). Save cert + private key.
2. Copy to VPS: `scp` to `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`, `chmod 0600` for the key.
3. Back up the Caddyfile: `cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)`.
4. Append the block above. Validate: `docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile`.
5. Reload (graceful, no drop): `docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
6. In Cloudflare DNS: A record (proxied) `assessiq` → VPS IPv4 (`72.61.227.64`). SSL/TLS mode for the zone: **Full (Strict)**.
7. Smoke: `curl -I https://assessiq.automateedge.cloud/` → expect 200/301 from Caddy with `server: Caddy` and CF headers.

If validation fails: do **not** reload. Caddy keeps the old config running. Investigate, fix, re-validate.

### Current live state — Phase 1 G1.D split-route + frontend (2026-05-03)

`assessiq-api` and `assessiq-frontend` are both live. The frontend container ships at SHA `3ef4e25` — multi-stage Vite SPA build (apps/web) on `nginx:alpine`, 73.9 MB image, exposing host port 9091. The Caddy block does a split-route: API + embed + public-help + take/start paths reach the API container on 9092; the default route reverse-proxies to the frontend container on 9091.

**What changed 2026-05-02 (Phase 1 G1.A Session 2):** the `@api` matcher gained `/help/*` so that `modules/16-help-system`'s anonymous public route `GET /help/:key` (registered without an `/api` prefix by design — embed-friendly short URL, parallel to `/embed*`) reaches `assessiq-api`. Pre-fix, `/help/...` fell through to the SPA `handle` and returned `index.html` with HTTP 200 instead of the JSON envelope. Caught in Phase 5 deploy smoke; see RCA `2026-05-02 — Caddy /help/* not forwarded`. The edit was additive only — no existing path was redirected away from anything.

**What changed 2026-05-03 (Phase 1 G1.D):** the `@api` matcher gained `/take/start` (narrowed to the exact POST path, not `/take/*`) so that `modules/06-attempt-engine`'s `POST /take/start` magic-link redemption reaches `assessiq-api`. `GET /take/:token` intentionally falls through to the SPA — the React Router `TokenLanding` page renders for any `/take/<token>` GET, and the SPA's page calls `POST /take/start` in the body. The Caddy container required a restart to pick up the inode-preserved Caddyfile edit (see RCA `2026-05-03 — Caddy @api matcher missing /take/*`).

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

**What's live (verified `2026-05-01`):**

- `GET https://assessiq.automateedge.cloud/` → 200 SPA shell (`<title>AssessIQ</title>`, hashed asset `/assets/index-<hash>.js`). SPA fallback verified — any deep route (e.g. `/admin/login`, `/admin/users`, `/some-non-existent-route`) returns the same index.html so react-router-dom can take over.
- `GET https://assessiq.automateedge.cloud/api/health` → 200 `{"status":"ok"}` — confirms split-route + container reachability.
- `GET https://assessiq.automateedge.cloud/help/admin.assessments.close.early?locale=en` → 200 with JSON envelope `{key, audience, locale, shortText, longMd}` — confirms the 2026-05-02 `/help/*` matcher addition; `GET /help/nonexistent.key` returns 404 `{"error":{"code":"NOT_FOUND",...}}` from the API (not the SPA fallback).
- `GET https://assessiq.automateedge.cloud/embed?token=...` → exercise of the addendum §5 HS256-only verify path. `alg=none` rejected with 401 INVALID_TOKEN; replay rejected with 401 INVALID_TOKEN (Redis cache populated).
- `GET https://assessiq.automateedge.cloud/api/auth/google/start?tenant=wipro-soc` → **401 AUTHN_FAILED `"Google SSO is not configured"`** — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are still empty (0 chars) in `/srv/assessiq/.env`. Route layer + tenant resolution proven correct (latency ~100 ms hitting tenant DB lookup); provisioning the OAuth client and restarting `assessiq-api` is the only remaining step. **DEFERRED — user-side task.**
- **Cache headers:** `index.html` returns `Cache-Control: no-cache, no-store, must-revalidate` (clients pick up new asset hashes after a deploy); hashed assets (`/assets/index-<hash>.js`, `.css`) return `Cache-Control: public, max-age=31536000, immutable`.
- **Security headers (from Caddy `security-headers` snippet):** HSTS, X-Frame-Options DENY, CSP `frame-ancestors 'none'`, X-Content-Type-Options nosniff.

**Historical — Phase 0 default-route swap (resolved 2026-05-01 at SHA 3ef4e25):** Earlier in Phase 0 closure the default route served a `respond 200` placeholder body until the frontend container shipped. The swap procedure (Python regex substitution against the existing `handle { ... respond 200 ... }` block, truncate-write of the new Caddyfile to preserve the bind-mount inode, validate-then-reload via `docker exec ti-platform-caddy-1 caddy ...`) is captured in the SHA-3ef4e25 deploy log; subsequent Caddyfile edits for AssessIQ should mirror that procedure.

**Historical — Phase 0 G0.A initial placeholder (resolved 2026-04-30 502 RCA):** Before the API container shipped, the entire AssessIQ block was a `respond 200` placeholder serving "We are building." That state was the resolution of the 502 incident on 2026-04-30 (DNS + Caddy wired ahead of any container).

## docker-compose.yml — `infra/docker-compose.yml` (in repo) → `/srv/assessiq/infra/docker-compose.yml` (on VPS)

> **Layout note (Phase 0 G0.A, 2026-05-01):** the compose file lives in the repo at `infra/docker-compose.yml`, not at the repo root. On the VPS clone it sits at `/srv/assessiq/infra/docker-compose.yml`. All commands are run from `/srv/assessiq/` with the explicit `-f` flag, e.g. `docker compose -f infra/docker-compose.yml up -d`. Relative paths inside the compose are resolved from the compose file location: `../.env` → `/srv/assessiq/.env`, `../secrets/pg_password.txt` → `/srv/assessiq/secrets/pg_password.txt`, `./postgres/init` → `/srv/assessiq/infra/postgres/init`, build context `..` → `/srv/assessiq/`.
>
> **`env_file` is declared with `required: false`** so `docker compose config` validates cleanly on a fresh clone before secrets are provisioned. Runtime safety is preserved by `modules/00-core/src/config.ts` — Zod validation throws on the first request if any required env var is missing.

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

- No `nginx` service. No `certbot` service. Caddy on the box does TLS for us.
- Container names explicit (`container_name: assessiq-*`) per CLAUDE.md rule #8.
- Only `assessiq-frontend` exposes a host port (`9091`). API, worker, postgres, redis are all internal to `assessiq-net`.
- `assessiq-api` does not get a host port — Caddy never talks to the API directly. The frontend's nginx (inside its container) reverse-proxies `/api`, `/embed`, `/take`, `/ws` to `assessiq-api:3000` on the internal network.

## .env template — `/srv/assessiq/.env`

```ini
# Domain
ASSESSIQ_BASE_URL=https://assessiq.automateedge.cloud
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
GOOGLE_OAUTH_REDIRECT=https://assessiq.automateedge.cloud/api/auth/google/cb

# Email (SMTP — Phase 3; stub-to-file in dev)
SMTP_URL=
EMAIL_FROM="AssessIQ <noreply@automateedge.cloud>"

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
```

**Local development:** the same keys live in `.env.local` at the repo root (gitignored — `.gitignore` covers `.env.*` with `!.env.example` allowlist). Never commit values; only `.env.example` is in the repo.

## DNS — Cloudflare

| Record | Type | Name | Value | Proxy | TTL |
| --- | --- | --- | --- | --- | --- |
| public | A | `assessiq` | `72.61.227.64` (VPS IPv4) | **Proxied (orange)** | Auto |

**Cloudflare zone settings** for `automateedge.cloud`:

- SSL/TLS encryption mode: **Full (Strict)**. Enforces a real cert at origin (the CF Origin Cert installed in Caddy).
- Edge Certificates: Universal SSL on (covers `assessiq.*` automatically).
- Always Use HTTPS: on.
- Min TLS Version: 1.2.
- Bot Fight Mode: on (free tier).
- WAF Managed Rules: on (free tier ruleset).

Client IPs reach Caddy via the `CF-Connecting-IP` header. Caddy's global `trusted_proxies` already lists Cloudflare's IP ranges; the auth module's rate-limiter must read client IP via Caddy's normalized request, NOT via raw `X-Forwarded-For`. Confirm in `01-auth` middleware tests.

## First-boot bootstrap (`/srv/assessiq/`)

Run as a non-root user with Docker group membership.

```bash
# 1. Clone (the SSH key for manishjnv@github is already on the box)
cd /srv && git clone git@github.com:manishjnv/assessIQ.git assessiq && cd assessiq

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

# 5. Append the AssessIQ Caddyfile block (see "Reverse-proxy plan" above)
sudo cp /opt/ti-platform/caddy/Caddyfile \
        /opt/ti-platform/caddy/Caddyfile.bak.$(date -u +%Y%m%d-%H%M%S)
# Append block; validate; reload:
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec ti-platform-caddy-1 caddy reload   --config /etc/caddy/Caddyfile

# 6. Confirm Cloudflare DNS A record (proxied) is set, SSL mode = Full (Strict)
dig +short assessiq.automateedge.cloud  # should return CF anycast IPs

# 7. Boot the AssessIQ stack
docker compose up -d

# 8. Run migrations
docker compose exec assessiq-api npm run db:migrate

# 9. Seed first tenant + admin user
docker compose exec assessiq-api npm run seed:bootstrap -- \
  --tenant-slug wipro-soc \
  --tenant-name "Wipro SOC" \
  --admin-email <admin@your-google-workspace> \
  --admin-name "Admin"
```

After bootstrap: log in at `https://assessiq.automateedge.cloud/admin/login`, complete TOTP enrollment, the platform is live.

## Backups — `/etc/cron.daily/assessiq-backup`

```bash
#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/var/backups/assessiq

mkdir -p $DEST
docker compose -f /srv/assessiq/docker-compose.yml exec -T assessiq-postgres \
  pg_dump -U assessiq -d assessiq -Fc | gzip > $DEST/assessiq-$TS.dump.gz

# Retention: 14 daily, 8 weekly (kept by hand)
find $DEST -name 'assessiq-*.dump.gz' -mtime +14 -delete

# Offsite (configure rclone remote separately)
rclone copy $DEST/assessiq-$TS.dump.gz remote:assessiq-backups/ || true
```

**Restore drill (run monthly):** `pg_restore -d assessiq_restore_test < assessiq-YYYY...dump.gz`. Log the result in `docs/RCA_LOG.md` if anything wobbles.

> See § Disaster recovery below for the full backup-contents inventory (including which artefacts are intentionally NOT backed up), the fresh-VPS restore procedure with expected outputs, failure-mode runbooks, recovery-readiness monitoring thresholds, and the secret-rotation procedure. The cron snippet above is the producer; the DR section is the consumer.

## Monitoring

| Signal | Where | Alert if |
| --- | --- | --- |
| HTTP 5xx rate | Caddy access log → log shipper | > 1% over 5 min |
| API p95 latency | structured logs (pino) | > 500ms over 5 min |
| Postgres connections | `pg_stat_activity` | > 80% of max |
| Redis memory | `INFO memory` | > 80% of maxmemory |
| Grading job age | `grading_jobs` query | oldest queued > 10 min (Phase 2+) |
| **Worker queue depth** | `GET /api/admin/worker/stats` (admin auth, 5s TTL cache) — see [docs/03-api-contract.md § Admin — Worker observability](03-api-contract.md) and [docs/11-observability.md § 13](11-observability.md) | `counts.waiting > 50` **OR** `counts.failed > 10`, sustained over 10 min — both indicate the BullMQ scheduler is unable to drain (Redis stall, Postgres saturation, downstream service exhaustion). Phase 1 — single-replica worker on a 60s/30s cadence; sustained depth > 50 is well outside steady state where both queues should be empty between ticks. |
| **Worker permanent failures** | `worker.log` — `jq 'select(.msg == "worker.job.failed.permanent")' /var/log/assessiq/worker.log` | any line in the last 30 min — every entry means a job exhausted its 5 retries (per [JOB_RETRY_POLICY](../apps/api/src/worker.ts)). Investigate via `GET /api/admin/worker/failed` for the redacted payload + stack tail; manual recover via `POST /api/admin/worker/failed/:id/retry` after fixing root cause. |
| Disk free | `df -h /` | < 20% on the volume holding `assessiq_pgdata` |
| TLS expiry | `openssl s_client -showcerts` against the origin | < 60 days remaining (CF Origin Cert is 15y, but watch CF edge cert too) |
| CF Origin pull errors | Cloudflare dashboard → Analytics | sustained 5xx from origin |

For v1 piggyback on whatever ti-platform already exposes (likely Prometheus + Grafana on this box already — confirm before adding a duplicate stack).

> See § Disaster recovery → § Recovery readiness for the additional freshness alerts that watch the backup pipeline itself (backup file age, offsite sync staleness, restore-drill recency). Those signals are read from filesystem mtimes + rclone log + a drill marker file rather than from the runtime stack, so they live in the DR section rather than this table.

## Disaster recovery

This section pins the procedure for restoring AssessIQ after a catastrophic failure of the Hostinger VPS, the Postgres data volume, or the broader shared-infra stack. It is procedure-only; setting up the offsite target (rclone + B2 bucket), wiring monitoring agents, and shipping a `dr-drill.sh` automation script are explicitly out of scope here and tracked separately. This section consumes the `## Backups` cron, the secret files at `/srv/assessiq/secrets/`, and the additive Caddy block at `/opt/ti-platform/caddy/Caddyfile`; it produces the operational confidence that a known-bad event has a known-good recovery path inside the documented RTO.

### Recovery objectives (RTO / RPO)

| Objective | Target | Phase |
| --- | --- | --- |
| **RTO** (recovery time objective) | **1 hour** from incident declaration to service restored on a fresh VPS, assuming offsite backups are intact and reachable | Phase 1 |
| **RPO** (recovery point objective) | **24 hours** of data loss tolerance — daily logical `pg_dump` is the only persistence point | Phase 1 |
| RPO upgrade path | sub-hour via WAL streaming to offsite (e.g. wal-g + B2) or a managed Postgres with PITR | Phase 4+ |

**What changed:** previously the deployment doc had no explicit RTO/RPO, only a bare cron snippet and a one-line drill reminder. **Why:** without pinned objectives the team can't tell whether the existing `pg_dump|gzip` pipeline is fit for purpose or whether it's silently under-spec; pinning 1h/24h forces every future infra decision (cron cadence, offsite frequency, alert thresholds) to be answerable against a target. **Considered and rejected:** (a) WAL streaming + sub-hour RPO from day one — rejected because the operational complexity (wal-g daemon, retention pruning, disaster-restore PITR drill) is disproportionate to a Phase 1 SOC pack with a single-digit-tenant load; the path is documented as Phase 4+ so the upgrade is trivial when it's earned. (b) RTO < 1h via a hot standby — rejected for the same Phase-1-cost reason and because a hot standby on the same shared VPS adds zero failure-domain coverage. **NOT included:** zero-RTO failover, multi-region replication, or any guarantee for the broader shared infra (Caddy, ti-platform stack) — those failure modes have their own runbooks below. **Downstream impact:** the 30-hour backup-freshness alert in § Recovery readiness derives from this RPO (one missed nightly cron + a 6h grace); the secret rotation cadence in § Secret rotation procedure can be slower than RPO because secrets that exist in the password manager are not bound by the data-loss window.

### Backup inventory

What exists, where, retention, and (importantly) what is intentionally NOT backed up.

| Artefact | Location | Retention | Backed up? | Notes |
| --- | --- | --- | --- | --- |
| Postgres logical dump | `/var/backups/assessiq/assessiq-<UTC-ts>.dump.gz` | **14 daily on disk**, **8 weekly archived by hand** | ✅ produced by `/etc/cron.daily/assessiq-backup` | Format: `pg_dump -Fc` (custom), gzip-compressed. Restore via `pg_restore`, NOT `psql`. |
| Postgres dump (offsite copy) | `remote:assessiq-backups-prod/assessiq-<UTC-ts>.dump.gz` (rclone target — placeholder bucket name; user wires actual B2 / S3 credentials separately) | match local cadence; offsite-only retention TBD by storage cost | ✅ pushed by the rclone line at the end of the cron | The `\|\| true` in the cron means an offsite-push failure does not fail the local backup; a missed offsite push must be caught by § Recovery readiness "offsite sync freshness" alert, not by cron exit code. |
| `/srv/assessiq/.env` | VPS only | n/a — operational secrets | ❌ **never offsite** | Re-generated from password manager + `ASSESSIQ_MASTER_KEY` rotation procedure. See § Secret rotation procedure. |
| `/srv/assessiq/secrets/*.txt` (pg_password, assessiq_app_password, assessiq_system_password) | VPS only | n/a | ❌ **never offsite** | Re-generated on restore via `openssl rand -base64 32`. The freshly-restored Postgres has the OLD passwords baked into its catalog (from the dump); the restore procedure includes an `ALTER ROLE` step to align the database with the new secret files. |
| Redis (BullMQ queues, sessions, rate-limit counters) | `assessiq_redis` Docker volume | AOF + `--save 60 1000` | ❌ **intentionally not backed up** | All three Redis purposes are recoverable-on-loss: sessions invalidate (users re-login via Google SSO), BullMQ queues drop (admin re-triggers any failed grading jobs from the dashboard once it ships), rate-limit counters reset (a brief permissive window is acceptable). Backing up Redis would buy nothing AssessIQ cares about and would complicate a parallel-restore. |
| CF Origin Cert (`/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`) | VPS only | 15-year validity | ❌ **regenerate from CF dashboard** | Manual procedure documented in `## Reverse-proxy plan` § Apply procedure step 1. **Re-paste re-exposes RCA `2026-04-30 — CF Origin Cert paste artifact`** — apply the `sed` cleanup on the new cert too. The 15-year horizon means rotation is rare; the cert is not bound by RTO. |
| Caddy block (`/opt/ti-platform/caddy/Caddyfile` AssessIQ section) | shared file with timestamped `.bak.<UTC-ts>` siblings | per-edit backups, no auto-pruning | ⚠️ implicit via the `cp .bak.` step in § Reverse-proxy plan and § swap-back; not a true backup | A fresh-VPS rebuild copies the AssessIQ block from this doc into a fresh ti-platform Caddyfile. The doc IS the backup of the block's intent. |
| Application code | `manishjnv/assessIQ` GitHub | git history | ✅ implicit via origin remote | Restore is `git clone`; no separate backup needed. |
| AI prompt skills (`~/.claude/skills/grade-{anchors,band,escalate}/SKILL.md`) on VPS | VPS only | n/a Phase 1 | ❌ deferred to Phase 2 | Phase 1 grading runs as Claude Code CLI under admin Max OAuth; the skills are author-edited on the VPS per `CLAUDE.md` rule #6. Their sha256 lands on every grading row. Phase 2 moves them into the repo at `modules/07-ai-grading/prompts/` with API-key auth — backup happens automatically via git at that point. |

**What changed:** the original `## Backups` section listed only the Postgres dump cadence and offsite line; it did not enumerate Redis, CF cert, the env file, the secrets, or the Caddy block, and it did not flag which artefacts are intentionally NOT backed up. **Why:** restore-time confusion is the #1 cause of blown RTOs — the operator needs an unambiguous "is this thing on the list, and if not, what do I do instead?" reference, not a guess based on what they happened to remember. **Considered and rejected:** backing up Redis "for completeness" — rejected because it complicates parallel-restore, doubles offsite egress, and AssessIQ has no Redis-only state worth recovering. **NOT included:** offsite of the `.env` (operational secret hygiene; the password manager is the source of truth), backups of the broader shared VPS state (out of scope per `CLAUDE.md` rule #8 — that's the ti-platform owner's responsibility). **Downstream impact:** the restore procedure below assumes exactly the artefacts in this table exist or are regenerable; the failure-mode runbooks branch on whether a given failure-mode loses something on the table or off it.

### Restore procedure (fresh-VPS rebuild)

Targets RTO 1h. Run as root (or a sudoer with passwordless sudo) on the new VPS. Every step respects `CLAUDE.md` rule #8 — additive only, AssessIQ-namespaced, never touches non-`assessiq-*` artefacts on the shared box. The Caddy-block-restore step (#6) uses the established AssessIQ-block exception in the same rule.

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
# Append the AssessIQ block from § Reverse-proxy plan above using `cat new >> Caddyfile`
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

Update the Cloudflare A record `assessiq.automateedge.cloud` → new VPS IPv4 BEFORE step 4 if the IP changed (proxied; CF DNS propagation through CF edge is < 30s for proxied records). DNS update is the only step that touches state outside the VPS.

**What changed:** the prior deployment doc had no fresh-VPS restore procedure — only the cron snippet and a one-line monthly-drill reminder. **Why:** without an end-to-end procedure with commands, expected outputs, and the order in which they run, the operator under stress reaches for guesses; the 1h RTO is unattainable without it. **Considered and rejected:** (a) restoring with `psql` from a plain SQL dump — rejected because the cron uses `pg_dump -Fc` (custom format) and `psql` cannot read it; using `pg_restore` is non-negotiable. (b) Bringing up `assessiq-api` before the role-password realignment — rejected because the API connects as `assessiq_app` with the new password from the secret file, while the freshly-restored `pg_authid` still has the old password baked in; the API would crash-loop until `ALTER ROLE` ran. (c) Standing up a brand-new Caddy instance on the new VPS — rejected per `CLAUDE.md` rule #8; the additive-only constraint means we restore the AssessIQ block on the existing `ti-platform-caddy-1`. **NOT included:** restore from a partial / corrupted dump (a separate diagnostic procedure that uses `pg_restore --list` to identify recoverable objects), restore of the BullMQ queue contents (intentionally not backed up — admin re-triggers any failed grading jobs), restore of the prior `.env` byte-for-byte (only the values regenerable from the password manager + `ASSESSIQ_MASTER_KEY` source-of-truth are recreated). **Downstream impact:** § Recovery readiness "restore drill staleness" alert exists because the only way to know this procedure still works is to run it monthly; § Failure modes "VPS dead" branches into this procedure as its concrete remediation.

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

Append the drill outcome to `docs/RCA_LOG.md` ONLY if anything wobbled (row counts mismatched, restore errored, an unexpected migration was missing, the offsite copy was unreadable). Successful drills are recorded by the marker file, not the RCA log — RCA is for incidents, not for routine confirmations.

**What changed:** previously a single-line "run monthly" reminder with no concrete procedure. **Why:** an unverified backup is hypothetical; the drill is the verification. The side-container approach (separate database name, drop-after-verify) means the production stack is untouched — the drill never risks production. **Considered and rejected:** (a) running the drill against a separate Postgres instance — rejected as overhead; the production Postgres can host a temporary database without side effects given the brief verification window. (b) automating via a `dr-drill.sh` script — out of scope this session per the user's pin; the procedure-first approach lets the operator run it interactively while learning the failure surface, and a future session can wrap it. **NOT included:** schema-diff verification against migration files (Phase 2+ when `tools/migrate.ts` ships with a tracking table), full app-level smoke against the restored database (the production stack stays in front of the production database; flipping it temporarily would defeat the side-container isolation). **Downstream impact:** the `.last-drill` marker file is what § Recovery readiness "restore drill staleness" alert reads; without the marker, there's no signal to alert on.

### Failure modes & runbooks

| Failure mode | Recovery | Owner |
| --- | --- | --- |
| **Postgres data corruption / volume loss** (most common — disk failure, accidental `DROP`, bad migration) | § Restore procedure above. RTO 1h, RPO 24h. If only the volume is lost (VPS otherwise healthy), skip steps 1, 4-5, 11; just restore Postgres in place. | AssessIQ |
| **Redis loss** (volume corruption, OOM kill, container removal) | Expected and tolerated. Sessions invalidate (users re-login via Google SSO + TOTP), BullMQ queues drop (admin re-triggers any failed grading jobs from the admin dashboard once it ships — Phase 2; for Phase 1 there is no async grading queue, so the failure surface is just sessions), rate-limit counters reset. **No restore action needed**; `docker compose up -d assessiq-redis` brings it back empty. | AssessIQ |
| **Caddy down / shared edge unhealthy** | All apps on the box return 5xx publicly, not just AssessIQ. AssessIQ has no recourse alone — the Caddyfile and the `ti-platform-caddy-1` container belong to ti-platform. **Escalate to the ti-platform owner.** Do NOT attempt to start a parallel Caddy on host:80/:443 — it will fail to bind, and even if it succeeded, it would steal traffic from the other apps in violation of `CLAUDE.md` rule #8. | ti-platform (escalation only) |
| **VPS dead** (host failure, full disk, irrecoverable OS state) | Spin up a fresh Hostinger VPS in the same region; install Docker + git + openssl + rclone; then run the § Restore procedure end-to-end. Update Cloudflare A record `assessiq.automateedge.cloud` → new VPS IPv4 (proxied — DNS propagation through CF edge is < 30s). Re-paste CF Origin Cert and re-apply the **`sed` paste-artifact cleanup** per RCA `2026-04-30`. The other apps on the original box (ti-platform, accessbridge, roadmap) are out of scope — their owners restore their own stacks; AssessIQ is the first restore on the fresh box only if AssessIQ-owned. | AssessIQ (own stack); other-app owners (their stacks) |
| **Cloudflare Origin Cert expired or compromised** | Generate a new cert in CF dashboard (Zero Trust → Origin Server → Create Certificate, RSA 2048, 15-year). Place at `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}`, **apply `sed` paste-artifact cleanup**, verify with `openssl x509 -noout -subject` and modulus-MD5 cert↔key match, then `caddy validate` + `caddy reload`. The 15-year horizon means this is rare; a compromised cert (key leaked) requires immediate rotation regardless of expiry. | AssessIQ |
| **`ASSESSIQ_MASTER_KEY` lost** (env file corrupted, password manager record lost, no rotation log) | **Worst-case:** TOTP secrets, embed secrets, recovery codes, and webhook secrets in the database are unrecoverable encrypted blobs. Restore proceeds, but: (a) all admin users must re-enroll TOTP on next login, (b) all per-tenant embed secrets must be re-issued (host-app integrations break until re-issued), (c) all recovery codes regenerate, (d) all webhook secrets re-issue (callers receive new signing secret). This is the strongest motivation for the password-manager discipline below. | AssessIQ + tenant admins (re-enrollment) |
| **`SESSION_SECRET` lost** | All active sessions invalidate; users re-login. No data loss. | AssessIQ |

**What changed:** previously the doc had no failure-mode taxonomy at all — every incident was reasoned-from-first-principles under stress. **Why:** the operator under stress needs to look up "Redis crashed, what now?" and get an answer in seconds; the table is a flat lookup that prevents the wrong action (e.g. "restore Redis from backup" when there is no Redis backup and the right action is to do nothing). **Considered and rejected:** a fully automated failover for any of these — rejected per Phase-1-cost reasoning above; manual escalation with a clear runbook is the right rigor for the current load. **NOT included:** runbooks for failure modes inside the broader shared VPS that AssessIQ doesn't own (Caddy runbook is escalation-only — the actual fix lives in ti-platform's docs); runbooks for Anthropic API or Claude Code CLI failures (Phase 1 grading is an admin-click sync action — if Claude Code fails, the admin sees the error and retries, no data integrity at risk). **Downstream impact:** the "VPS dead" branch consumes the entire § Restore procedure; the `ASSESSIQ_MASTER_KEY` row is the single most-important argument for the rotation-and-storage discipline in § Secret rotation procedure.

### Recovery readiness monitoring

This is a **subsection of § Monitoring**, not a duplicate. The § Monitoring table above watches the running stack (HTTP 5xx rate, p95 latency, Postgres connections, Redis memory, grading job age, disk free, TLS expiry, CF origin pull errors). This subsection watches the **backup pipeline itself** — signals that say "if we needed to restore right now, would we be able to?".

| Signal | Where | Alert if |
| --- | --- | --- |
| Backup freshness (local) | `find /var/backups/assessiq -name 'assessiq-*.dump.gz' -newer <30h-ago>` | no file newer than **30 hours** (one missed nightly cron + a 6h grace) |
| Offsite sync freshness | `rclone log` mtime + last-success grep, e.g. `tail /var/log/assessiq/rclone.log \| grep -E 'Transferred:.+OK'` | no successful push in **30 hours** (matches local cadence; the `\|\| true` in the cron means a silent failure here is the only signal) |
| Restore drill staleness | `mtime` of `/var/backups/assessiq/.last-drill` | older than **35 days** (5 days of grace beyond the monthly cadence) |
| Dump file size delta | `stat -c %s` of latest vs prior dump | **> 10% shrink** (data loss / botched migration) **or > 30% growth** (runaway log table) — both warrant investigation, neither is a hard alert |

**What changed:** the existing § Monitoring table watches the live stack but had no signals on the backup pipeline; a silent backup failure (cron exit 0 from `|| true` on rclone error, disk full preventing the dump from being created in the first place) could go undetected indefinitely until a real disaster reveals there's nothing to restore from. **Why:** a backup pipeline you don't watch is a backup pipeline that has failed. The freshness alerts are the cheapest possible signal that catches the most common failure modes. **Considered and rejected:** (a) a more sophisticated "test-restore-into-temp-db nightly" check — rejected because the monthly drill already covers correctness verification; nightly would burn IO without proportional confidence. (b) shipping the alerts via a separate alerting stack — rejected because v1 piggybacks on whatever ti-platform exposes (per the existing § Monitoring closing note); the right time to choose a delivery channel is when the user wires the alerts. **NOT included:** alerting destinations (Slack vs email vs PagerDuty — operator's choice), credential setup for the alerting agent, the agent itself. **Downstream impact:** these alerts are the only feedback loop on the backup cron and the drill cadence; without them the discipline of "run the drill monthly" is volunteer-only.

### Secret rotation procedure

| Secret | Storage | Rotation cadence | Procedure | Downtime |
| --- | --- | --- | --- | --- |
| `pg_password` (postgres superuser) | `/srv/assessiq/secrets/pg_password.txt`, password manager mirror | annual minimum or on-incident | Generate new value (`openssl rand -base64 32`), `ALTER USER assessiq PASSWORD '<new>'`, write new value to secret file (atomic mv inside the secrets dir is fine — no bind-mount inode trap on these files), restart `assessiq-postgres` is NOT required (Postgres re-reads on next auth). | none |
| `assessiq_app_password` / `assessiq_system_password` (RLS roles) | `/srv/assessiq/secrets/assessiq_{app,system}_password.txt`, password manager mirror | annual minimum or on-incident | Same `ALTER ROLE` pattern as above, then update `DATABASE_URL` in `.env`, then `docker compose restart assessiq-api assessiq-worker`. | brief — API in-flight requests fail during the restart window (~5s) |
| `SESSION_SECRET` | `/srv/assessiq/.env`, password manager mirror | annual minimum or on-incident | Edit `.env`, `docker compose restart assessiq-api`. **All active sessions invalidate immediately** — users re-login. | session invalidation (no data loss) |
| `ASSESSIQ_MASTER_KEY` | `/srv/assessiq/.env`, **password manager mirror MANDATORY** (loss = unrecoverable encrypted blobs in DB) | annual minimum or on-incident | The hard one. Procedure: (a) generate new key (`openssl rand -base64 32`); (b) write a one-shot re-encryption script that reads each encrypted column (`users.totp_secret_enc`, `oauth_identities.refresh_token_enc`, `tenants.embed_secret_enc`, etc. — schema enumerates the full list), decrypts with the OLD key, re-encrypts with the NEW key, writes back inside a single transaction per row; (c) keep BOTH keys readable during the transition (`ASSESSIQ_MASTER_KEY=<new>`, `ASSESSIQ_MASTER_KEY_PREVIOUS=<old>` — the decrypt path tries new-first then old-fallback); (d) once the script confirms 100% migrated, drop `ASSESSIQ_MASTER_KEY_PREVIOUS`. | none if the dual-key fallback is implemented in `00-core` crypto helpers; brief otherwise |
| `GOOGLE_CLIENT_SECRET` | `/srv/assessiq/.env`, Google Cloud Console mirror | on-incident only (Google rotation does not invalidate active sessions) | Generate new client secret in Google Cloud Console, edit `.env`, `docker compose restart assessiq-api`. Old secret stays valid until you delete it in the console — overlap window protects against bad rotation. | none |
| Per-tenant `embed_secret` (one per tenant, encrypted at rest with `ASSESSIQ_MASTER_KEY`) | `tenants.embed_secret_enc` column | on-incident or on-host-app-request | **Invalidate-and-reissue** — there is no rotation, only re-issuance: generate new `embed_secret` per tenant, store encrypted, communicate to host app out-of-band. Old JWTs signed with the old secret reject immediately. | host-app embed integrations break until they update their JWT-signing secret |

**What changed:** previously the doc listed the env vars but had no rotation procedure for any of them; the most consequential secret (`ASSESSIQ_MASTER_KEY`) had no documented re-encryption path. **Why:** secrets that have no documented rotation procedure either don't get rotated (compliance/security risk) or get rotated badly (operational outage), and `ASSESSIQ_MASTER_KEY` specifically can soft-brick the system if rotated naively without the dual-key fallback. **Considered and rejected:** (a) building the dual-key fallback into `00-core` immediately — recorded as a Phase 1 hardening item (the `00-core` crypto helpers exist but accept only a single key today; the master-key-rotation row in the table is contingent on Phase 1 lifting that). (b) automating master-key rotation on a calendar — rejected; rotation is a known-disruptive event that should be operator-driven, not cron-driven. **NOT included:** key escrow / split-knowledge for `ASSESSIQ_MASTER_KEY` (Phase 4+ if a tenant requires it), HSM integration, automatic rotation on detected compromise. **Downstream impact:** the failure-mode runbook "ASSESSIQ_MASTER_KEY lost" branches into the worst-case re-enrollment workflow precisely because the rotation procedure here lays out the controlled path that loss bypasses; the embed-secret invalidate-and-reissue model means host apps must accept that their integration is bound to one tenant's choice of secret-rotation cadence.

## Scale-out path

Same as before: API replicas → managed Postgres → worker pool → multi-region. None of this changes with the Caddy-fronted topology — when AssessIQ moves off the shared VPS, it takes its own ingress (a fresh nginx or its own Caddy) with it and Cloudflare just repoints.

## Out of scope for Phase 0 deployment

- Anthropic API key wiring (Phase 2 only; Phase 1 uses Claude Code CLI).
- Self-managed Let's Encrypt for the public cert (Cloudflare handles edge; CF Origin Cert handles origin).
- Per-tenant custom domains (Phase 3+).
- HA Postgres / Redis (Phase 4+ if a client demands it).
- Sentry integration (placeholder env var; wire when an account is created).
