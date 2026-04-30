# 06 — Deployment

## Target topology

Single Hostinger VPS (Ubuntu 24 LTS, 4 vCPU / 16 GB RAM minimum, 8 GB / 32 GB recommended for production). All services run as Docker containers under one Compose file, fronted by a single nginx that handles TLS and routing.

```
               Internet
                  │
                  ▼
          ┌─────────────┐
          │   nginx     │   :80 → :443 redirect
          │ (TLS, ACME) │   :443 → upstreams below
          └──┬──────────┘
             │
   ┌─────────┼──────────────────┐
   ▼         ▼                  ▼
 /api,/embed,/ws,/auth   /(SPA)  /static
   ▼         ▼                  ▼
 ┌───────┐ ┌───────────┐  ┌──────────────┐
 │  api  │ │ frontend  │  │ /var/www/aiq │
 │ (3000)│ │ (nginx)   │  │ (mounted)    │
 └───┬───┘ └───────────┘  └──────────────┘
     │
     ├────► postgres (5432)
     ├────► redis (6379)
     │
     └────► worker  (no public port; subscribes to Redis)
                  │
                  └────► Anthropic API (egress only)
```

## docker-compose.assess.yml

```yaml
version: "3.9"

x-defaults: &svc-defaults
  restart: unless-stopped
  init: true
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }

services:
  postgres:
    <<: *svc-defaults
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: assessiq
      POSTGRES_USER: assessiq
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    volumes:
      - aiq_pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    secrets: [pg_password]
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U assessiq -d assessiq"]
      interval: 10s
      timeout: 3s
      retries: 5

  redis:
    <<: *svc-defaults
    image: redis:7-alpine
    command: ["redis-server","--appendonly","yes","--save","60 1000"]
    volumes:
      - aiq_redis:/data
    healthcheck:
      test: ["CMD","redis-cli","ping"]
      interval: 10s
      retries: 5

  api:
    <<: *svc-defaults
    image: assessiq/api:${IMAGE_TAG:-latest}
    build:
      context: .
      dockerfile: ./infra/docker/api.Dockerfile
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    expose: ["3000"]
    healthcheck:
      test: ["CMD","wget","-q","--spider","http://localhost:3000/api/health"]
      interval: 15s
      retries: 3

  worker:
    <<: *svc-defaults
    image: assessiq/api:${IMAGE_TAG:-latest}
    command: ["node","dist/worker.js"]
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    healthcheck:
      test: ["CMD","node","dist/worker-health.js"]
      interval: 30s
      retries: 3

  frontend:
    <<: *svc-defaults
    image: assessiq/frontend:${IMAGE_TAG:-latest}
    build:
      context: .
      dockerfile: ./infra/docker/frontend.Dockerfile
    expose: ["80"]

  nginx:
    <<: *svc-defaults
    image: nginx:1.27-alpine
    ports: ["80:80","443:443"]
    volumes:
      - ./infra/nginx/conf.d:/etc/nginx/conf.d:ro
      - aiq_certs:/etc/letsencrypt
      - aiq_acme:/var/www/certbot
    depends_on: [api, frontend]

  certbot:
    image: certbot/certbot:latest
    volumes:
      - aiq_certs:/etc/letsencrypt
      - aiq_acme:/var/www/certbot
    entrypoint: >
      sh -c "trap exit TERM; while :; do certbot renew --quiet
      --webroot --webroot-path=/var/www/certbot;
      sleep 12h & wait $${!}; done"

volumes:
  aiq_pgdata:
  aiq_redis:
  aiq_certs:
  aiq_acme:

secrets:
  pg_password:
    file: ./infra/secrets/pg_password.txt
```

## .env template

```ini
# Domain
ASSESSIQ_BASE_URL=https://assessiq.automateedge.cloud
ASSESSIQ_NODE_ENV=production

# Postgres
DATABASE_URL=postgres://assessiq:<read-from-secrets-file>@postgres:5432/assessiq

# Redis
REDIS_URL=redis://redis:6379

# Master encryption key (32-byte base64) — for TOTP secrets, embed secrets, webhook secrets
ASSESSIQ_MASTER_KEY=<base64-encoded-32-bytes>

# Session signing
SESSION_SECRET=<base64-encoded-32-bytes>

# Google OIDC
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT=https://assessiq.automateedge.cloud/api/auth/google/cb

# Anthropic — production grading
ANTHROPIC_API_KEY=

# Email (SMTP — Sendgrid, AWS SES, or any provider)
SMTP_URL=smtps://...
EMAIL_FROM="AssessIQ <noreply@automateedge.cloud>"

# Observability
LOG_LEVEL=info
SENTRY_DSN=

# Feature flags
FEATURE_MAGIC_LINK=true
FEATURE_EMBED=true
```

## nginx/conf.d/assessiq.conf

```nginx
upstream aiq_api      { server api:3000; keepalive 32; }
upstream aiq_frontend { server frontend:80; keepalive 16; }

# HTTP → HTTPS
server {
  listen 80;
  server_name assessiq.automateedge.cloud;

  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name assessiq.automateedge.cloud;

  ssl_certificate     /etc/letsencrypt/live/assessiq.automateedge.cloud/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/assessiq.automateedge.cloud/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  ssl_prefer_server_ciphers on;
  ssl_session_cache shared:SSL:10m;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options nosniff;
  add_header X-Frame-Options DENY;
  add_header Referrer-Policy strict-origin-when-cross-origin;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()";

  # CSP — note 'frame-ancestors' is loose to allow embed; tighten per tenant via header from app
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss:; frame-ancestors *;" always;

  client_max_body_size 5m;
  gzip on;
  gzip_types text/plain application/json application/javascript text/css;

  # API + auth + embed
  location /api/ {
    proxy_pass http://aiq_api;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
  }

  location /embed { proxy_pass http://aiq_api; }
  location /take  { proxy_pass http://aiq_api; }

  location /ws {
    proxy_pass http://aiq_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }

  # Auth rate-limit zone (configure in /etc/nginx/nginx.conf)
  # limit_req_zone $binary_remote_addr zone=aiq_auth:10m rate=10r/m;
  location ~ ^/api/auth/(google/start|totp/verify|totp/recovery|logout) {
    limit_req zone=aiq_auth burst=5 nodelay;
    proxy_pass http://aiq_api;
  }

  # SPA fallback
  location / { proxy_pass http://aiq_frontend; }
}
```

## DNS

Point `assessiq.automateedge.cloud` (A record) to the VPS IPv4. If using Cloudflare proxy, **disable proxy for the ACME challenge subpath** during initial cert issuance, or use DNS-01 challenge instead. After issuance, you can re-enable Cloudflare in front (set Cloudflare SSL mode to "Full (strict)").

## First-boot bootstrap

```bash
# On VPS
cd /opt && git clone <repo> assessiq && cd assessiq

# Generate secrets
mkdir -p infra/secrets
openssl rand -base64 32 > infra/secrets/pg_password.txt
chmod 600 infra/secrets/pg_password.txt

# .env from template
cp .env.example .env
# fill in GOOGLE_OAUTH_*, ANTHROPIC_API_KEY, SMTP_URL, etc.
openssl rand -base64 32   # → ASSESSIQ_MASTER_KEY
openssl rand -base64 32   # → SESSION_SECRET

# Get certs (one-shot, before nginx with TLS works)
docker run --rm -v $(pwd)/infra/certs:/etc/letsencrypt -v $(pwd)/infra/acme:/var/www/certbot certbot/certbot \
  certonly --webroot --webroot-path=/var/www/certbot \
  -d assessiq.automateedge.cloud --email ops@automateedge.cloud --agree-tos --non-interactive

# Boot
docker compose -f docker-compose.assess.yml up -d

# Run migrations
docker compose exec api npm run db:migrate

# Seed first tenant + admin user
docker compose exec api npm run seed:bootstrap -- \
  --tenant-slug wipro-soc \
  --tenant-name "Wipro SOC" \
  --admin-email manish@wipro.com \
  --admin-name "Manish"
```

After bootstrap, log in at `https://assessiq.automateedge.cloud/admin`, complete TOTP enrollment, and the platform is live.

## Backups

```bash
# /etc/cron.daily/aiq-backup
#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/var/backups/assessiq

mkdir -p $DEST
docker compose -f /opt/assessiq/docker-compose.assess.yml exec -T postgres \
  pg_dump -U assessiq -d assessiq -Fc | gzip > $DEST/aiq-$TS.dump.gz

# Keep last 14 daily + 8 weekly
find $DEST -name 'aiq-*.dump.gz' -mtime +14 -delete

# Push offsite (rclone to B2 or S3)
rclone copy $DEST/aiq-$TS.dump.gz remote:assessiq-backups/
```

Test restore monthly: `pg_restore -d assessiq_restore_test < aiq-YYYY...dump.gz`.

## Monitoring

| Signal | Where | Alert if |
|---|---|---|
| HTTP 5xx rate | nginx access log → log shipper | > 1% over 5 min |
| API p95 latency | structured logs (pino) | > 500ms over 5 min |
| Postgres connections | `pg_stat_activity` exporter | > 80% of max |
| Redis memory | redis_exporter | > 80% of maxmemory |
| Grading job age | `grading_jobs` query | oldest queued > 10 min |
| Disk free | node_exporter | < 20% on volume holding `aiq_pgdata` |
| Anthropic cost | `grading_jobs.cost_*` rollup | > monthly tenant budget |

For v1 keep it simple: `node_exporter + prometheus + grafana` Compose alongside, or use a hosted option (Grafana Cloud free tier handles this scale fine). Reuse the dashboards you built for IntelWatch ETIP.

## Scale-out path

When single-VPS hits limits, the migration is mostly DNS + ops work, not code:
1. **API replicas first** — add a second VPS or move API to ECS/Cloud Run; Postgres + Redis stay on the original.
2. **Postgres next** — managed Postgres (AWS RDS / Supabase / Neon) when you need HA or read replicas.
3. **Worker pool** — autoscaling worker container based on `grading:queue` length.
4. **Multi-region** — only when contractually required by a client; tenants pinned to a region via `tenant_settings.data_region`.
