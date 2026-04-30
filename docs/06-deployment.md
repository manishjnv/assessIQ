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
| `/var/log/assessiq/` | this app | application logs that don't fit in Docker json-file |
| `/var/backups/assessiq/` | this app | nightly pg_dump destination |
| `/opt/ti-platform/caddy/Caddyfile` | **ti-platform (shared!)** | Global Caddy config; AssessIQ adds **one server block** here, never edits anything else |

**Hard rule (CLAUDE.md #8 reaffirmed):** AssessIQ's deploy diff is allowed to (a) create files under the four `assessiq`-prefixed paths above and (b) **append** one server block to the ti-platform Caddyfile. Anything else on this box is off-limits without explicit user approval.

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

## docker-compose.yml — `/srv/assessiq/docker-compose.yml`

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
      dockerfile: ./infra/docker/frontend.Dockerfile
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

## Monitoring

| Signal | Where | Alert if |
| --- | --- | --- |
| HTTP 5xx rate | Caddy access log → log shipper | > 1% over 5 min |
| API p95 latency | structured logs (pino) | > 500ms over 5 min |
| Postgres connections | `pg_stat_activity` | > 80% of max |
| Redis memory | `INFO memory` | > 80% of maxmemory |
| Grading job age | `grading_jobs` query | oldest queued > 10 min (Phase 2+) |
| Disk free | `df -h /` | < 20% on the volume holding `assessiq_pgdata` |
| TLS expiry | `openssl s_client -showcerts` against the origin | < 60 days remaining (CF Origin Cert is 15y, but watch CF edge cert too) |
| CF Origin pull errors | Cloudflare dashboard → Analytics | sustained 5xx from origin |

For v1 piggyback on whatever ti-platform already exposes (likely Prometheus + Grafana on this box already — confirm before adding a duplicate stack).

## Scale-out path

Same as before: API replicas → managed Postgres → worker pool → multi-region. None of this changes with the Caddy-fronted topology — when AssessIQ moves off the shared VPS, it takes its own ingress (a fresh nginx or its own Caddy) with it and Cloudflare just repoints.

## Out of scope for Phase 0 deployment

- Anthropic API key wiring (Phase 2 only; Phase 1 uses Claude Code CLI).
- Self-managed Let's Encrypt for the public cert (Cloudflare handles edge; CF Origin Cert handles origin).
- Per-tenant custom domains (Phase 3+).
- HA Postgres / Redis (Phase 4+ if a client demands it).
- Sentry integration (placeholder env var; wire when an account is created).
