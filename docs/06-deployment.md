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

## Pre-deploy lint gates

Four automated CI checks run in `.github/workflows/ci.yml` (step 12) via `pnpm lint:deploy-procedure`. Each check is independent; a violation in any one exits 1 and blocks the PR. Exit 0 means all four are clean. Exit 2 means the lint itself hit an internal error (missing file, parse failure).

`score-goldens` runs in CI as the AI generation eval gate. Failures block merge; surface evidence is in the CI step log under "AI generation eval gate".

Run locally:
```bash
pnpm lint:deploy-procedure            # full repo scan — shows violations with file:line + fix hint
pnpm lint:deploy-procedure:self-test  # validates the lint logic itself (17 assertions); run after editing the lint
pnpm lint:deploy-procedure --json     # machine-readable JSON output for scripted checks
```

RCA reference: `docs/RCA_LOG.md` 2026-05-08 entry documents the three incident classes (skill mount, env var, template URL) that drove this lint's creation.

---

### CHECK A — Skill bind-mount integrity

**What it catches:** A skill is committed under `prompts/skills/<name>/SKILL.md` but `infra/docker-compose.yml` has no volume mount mapping the skills directory into `assessiq-api` (and `assessiq-worker`). The running container reads the image's baked-in filesystem; `git pull` alone cannot update skills that aren't bind-mounted.

**Inverse:** If the mount exists but `prompts/skills/` contains no `SKILL.md` files, the lint also fires (dead bind-mount).

**Last incident:** 2026-05-08 — skill committed, runtime invisible. Root cause: bind-mount added after the fact.

**Canonical fix:**
```yaml
# infra/docker-compose.yml → services.assessiq-api.volumes (and assessiq-worker.volumes)
- ../prompts/skills:/home/node/.claude/skills:ro
```

---

### CHECK B — Migration apply chain

**What it catches:** A `.sql` file under `modules/` or `apps/` is not at the exact depth `modules/<name>/migrations/<file>.sql` — the only pattern `tools/migrate.ts` discovers. A file at `modules/foo/subdir/migrations/001.sql` or `apps/api/seeds/001.sql` is silently skipped at deploy time; the schema diverges from code without any error at startup.

**Exemption (manual migrations):** SQL files that are intentionally not run by the migration runner (fixtures, reference data, seed scripts) may carry this comment at the top of the file to suppress the violation:
```sql
-- DEPLOY: manual; not part of migration sequence
```

**Canonical fix for a violation:** Move the file to `modules/<name>/migrations/<file>.sql`, or add the exemption marker and document the manual apply step below under § Migrations.

---

### CHECK C — Env var declaration coverage

**What it catches:** `process.env.VAR_NAME` referenced in production source code but `VAR_NAME` does not appear anywhere in `.env.example` — not even in a comment. Operators provisioning a fresh deployment have no visibility that the variable exists or what it should contain.

**Last incident:** 2026-05-08 — `SMTP_URL` in `config.ts` Zod schema and used in code, but absent from `.env.example`. Email feature silently fell back to the dev stub on production.

**Skip list** (exempt by default — standard Node/CI system vars never in `.env.example`):
`NODE_ENV`, `NODE_VERSION`, `HOME`, `PATH`, `USER`, `HOSTNAME`, `SHELL`, `PWD`, `OLDPWD`,
`TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TMP`, `TEMP`, `XDG_RUNTIME_DIR`, `LOGNAME`,
`CI`, `GITHUB_ACTIONS`, `GITHUB_TOKEN`, `GITHUB_WORKSPACE`, `GITHUB_SHA`, `GITHUB_REF`,
`RUNNER_OS`, `PORT`, `LOG_DIR`.

**Canonical fix for a violation:** Add a placeholder line and an explanatory comment to `.env.example`. If the var is optional with a sensible default, declare it as `z.optional()` or `z.default()` in `modules/00-core/src/config.ts`.

**Pre-existing violations on current main** (punch list as of 2026-05-08 — tracked as follow-up sessions):

| Var | Read at | Action |
| --- | --- | --- |
| `ASSESSIQ_PUBLIC_URL` | `modules/05-assessment-lifecycle/src/service.ts:85` | alias for `ASSESSIQ_BASE_URL`; remove or alias in config.ts |
| `ASSESSIQ_DEV_EMAILS_LOG` | `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts:1148` | dev-only email log path; add to `.env.example` with comment |
| `AIQ_ADMIN_USER_ID` | `modules/07-ai-grading/eval/cli.ts:609` | eval CLI override; add to `.env.example` as optional |
| `S3_BUCKET` | `modules/14-audit-log/src/archive-job.ts:65` | audit-log S3 archival target; add to `.env.example` |
| `ENABLE_EMBED_TEST_MINTER` | `apps/api/src/routes/auth/embed.ts:173` | embed test gate; add to `.env.example` with prod=false note |
| `ENABLE_E2E_TEST_MINTER` | `apps/api/src/__tests__/routes/mint-session.test.ts:192` | in `config.ts` but missing from `.env.example`; add line |
| `PLAYWRIGHT_BASE_URL` | `apps/web/e2e/fixtures/factories.ts:24` | E2E test base URL; add to `.env.example` under E2E section |
| `E2E_API_BASE_URL` | `apps/web/e2e/fixtures/factories.ts:25` | E2E API base URL; add to `.env.example` under E2E section |
| `E2E_CANDIDATE_TOKEN` | `apps/web/e2e/take-happy-path.spec.ts:7` | E2E fixture token; add to `.env.example` under E2E section |

---

### CHECK D — Email template URL ↔ SPA route consistency

**What it catches:** A URL path constructed in email-sending service code (template literal `${base}/path/${segment}`) or a hardcoded `href` in a template HTML file uses a path whose first segment is not registered as a route in `apps/web/src/App.tsx`. The candidate clicks the link and lands on the SPA's 404 catch-all.

**Last incident:** 2026-05-04 — `modules/05-assessment-lifecycle/src/service.ts` built invitation links as `${PUBLIC_URL}/invite/${token}`. The SPA has no `/invite/:token` route; `/take/:token` is the correct candidate entry point. Candidates clicked the link and saw the 404 fallback.

**What is intentionally NOT checked:** Pure Handlebars placeholders (`href="{{invitationLink}}"`) — the URL is supplied by the caller, not embedded in the template. `https://` absolute URLs without a literal path fragment are also skipped.

**Canonical fix for a violation:** Either update the URL in service code / the template to use a registered SPA route, or add the missing route to `apps/web/src/App.tsx`. See `modules/13-notifications/src/__tests__/notifications.test.ts` for the regression guard that asserts `/take/` in candidate invitation emails.

---

## Authenticated Origin Pulls (AOP) — origin TLS-locked to Cloudflare (live 2026-05-20)

Closes the confirmed IP-spoof vuln (see `docs/RCA_LOG.md` 2026-05-19 and 2026-05-20) at the TLS layer: the origin rejects any HTTPS handshake that isn't presenting Cloudflare's zone-level Origin Pull client certificate. This is the **complete** fix; the app-layer `x-origin-verify` shared-secret (see `docs/04-auth-flows.md § Origin-verify header`) is defense-in-depth.

**State (verified):**

- Caddyfile (`/opt/ti-platform/caddy/Caddyfile`) AssessIQ block carries `tls ... { client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/ssl/cf-origin-pull-ca.pem } }`. **Only the AssessIQ site block has `client_auth`** — neighbors (`intelwatch.in`, `ti.intelwatch.in`, `automateedge.cloud`, `accessbridge.space`) are untouched and remain on standard TLS.
- CA cert (host) `/opt/ti-platform/caddy/ssl/cf-origin-pull-ca.pem` is the canonical Cloudflare Origin Pull CA (`CN=origin-pull.cloudflare.net`, SHA-256 `9A:1A:C2:B4:...:25:A2:B9`, valid through Nov 2029). Mount: `/opt/ti-platform/caddy/ssl → /etc/caddy/ssl` (host → container).
- Cloudflare-side: zone-level AOP enabled in the dashboard (Zone → SSL/TLS → Origin Server → Authenticated Origin Pulls → ON).

**Flip procedure (canary with auto-revert; reuse for any future Caddy edit):**

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

**Rollback.** Same `cat backup > Caddyfile` pattern + reload. `.bak.<TS>` files accumulate in `/opt/ti-platform/caddy/` (5 visible at last check, oldest May 2). Keep the last few; prune older.

**Operational notes:**

- **Bind-mount inode trap (RCA 2026-04-30)**: NEVER `mv newfile /opt/ti-platform/caddy/Caddyfile` and NEVER `sed -i` — those create a new inode, and Docker's bind-mount continues to point at the orphaned old inode. Caddy will reload from the OLD content. Use truncate-write (`cat >`, `printf >`, `tee` w/o `-a`) so the inode is preserved.
- **Caddy admin API**: `docker exec ti-platform-caddy-1 wget -qO- http://127.0.0.1:2019/config/` returns the currently-loaded JSON config — use to verify `client_auth`/`trusted_ca_cert` keys are actually present after reload (don't assume from the Caddyfile diff alone).
- **Caddy deprecation warning** logged on reload: `'trusted_ca_cert_file' field is deprecated. Use the 'trust_pool' field instead.` — Caddy v2.11.1. Non-breaking; tracked as Caddyfile hygiene follow-up.

## Domain switch to assessiq.in (2026-05-22)

**Status: LIVE & verified (2026-05-22).** All phases shipped: `assessiq.in` serves with AOP origin-lock; `www.assessiq.in` → apex; `assessiq.automateedge.cloud` 301s to `assessiq.in` (path+query preserved, still AOP-locked); `.env` base-URL + OIDC flipped; frontend rebuilt; `ORIGIN_VERIFY_SECRET` rotated. End-to-end test sweep green (health/SPA/SSO 302→assessiq.in, `/take/start` 404 not 429, direct-origin spoof rejected on both hosts, neighbors untouched). One gotcha cost a debugging cycle — see prerequisite #3 and RCA 2026-05-22.

**What changed.** The canonical public host moved from `assessiq.automateedge.cloud` to **`assessiq.in`**. `assessiq.in` now serves the app; `assessiq.automateedge.cloud` 301-redirects to it. Repo-side config changed: `ASSESSIQ_BASE_URL` and `GOOGLE_OAUTH_REDIRECT` (`.env.example`, prod `.env`, `vitest.setup.ts` default), the Caddy site blocks (`infra/caddyfile/assessiq.snippet`), candidate-facing footer strings (`CandidateLogin.tsx`, `TakeRightPane.tsx`), the embed-SDK CDN doc comment, and assorted test/tooling references.

**Why.** `assessiq.in` is the brand domain; `assessiq.automateedge.cloud` was always a stop-gap subdomain on existing infra (PROJECT_BRAIN decision 2026-04-29). Single canonical host keeps email links, the session-cookie scope, and SSO callbacks on one origin.

**Why a redirect, not a hard cutover.** Cookies are host-only (no `domain=` attribute) and the two hosts share no common parent, so a session cannot span both — there is no "alias" option that keeps you logged in across both. A 301 from the old host preserves already-sent magic-link / invitation tokens (the token rides through in the path/query) and live bookmarks. Chosen over killing the old host (which would 404 in-flight candidate emails).

**Prerequisites (dashboards — operator-only, must be done BEFORE the env flip):**

1. **Cloudflare (assessiq.in zone — already exists):** proxied A record `assessiq.in` → `72.61.227.64` (and `www` if used); SSL/TLS mode **Full (Strict)**.
2. **Cloudflare AOP (REQUIRED):** Zone → SSL/TLS → Origin Server → **Authenticated Origin Pulls** → turn on the **Global** toggle ("Cloudflare will use a **shared** TLS client certificate"). ⚠️ Use **Global**, NOT **Zone-level**. Global presents CF's shared Origin-Pull cert (`CN=origin-pull.cloudflare.net`), which is exactly what the box trusts via `cf-origin-pull-ca.pem` — reused as-is, no new CA. **Zone-level is the _custom-certificate_ path** — leave it OFF and do NOT upload a cert there; if a custom cert were uploaded, CF would present a cert the origin doesn't trust and every handshake would be rejected (site down). Without Global AOP on, Caddy's `client_auth { mode require_and_verify }` rejects every assessiq.in handshake.
3. **Cloudflare Transform Rule (REQUIRED — must be a _Request Header_ rule):** on the assessiq.in zone → **Rules → Transform Rules → Modify _Request_ Header** → match "All incoming requests" → `Set static x-origin-verify = <ORIGIN_VERIFY_SECRET>` → Deploy. Prod runs `ORIGIN_TRUST_MODE=enforce` and the app's check ([client-ip.ts](../modules/01-auth/src/client-ip.ts), [rate-limit.ts](../modules/01-auth/src/middleware/rate-limit.ts)) **fails closed** — without this, every rate-limited/auth route returns `429 "missing client IP for rate limit"`. ⚠️ **It MUST be a _Request_ header, NOT Response.** A Response-header rule never reaches the app (origin-verify fails → 429) **and** broadcasts the secret to every visitor (this exact mistake cost a cycle on 2026-05-22 — see RCA). The Origin-Pull CA is shared across zones, but `x-origin-verify`'s value is per-deployment — keep the rule value and `.env` `ORIGIN_VERIFY_SECRET` byte-identical. Health endpoints are exempt from the limiter, so verify with a rate-limited route (`POST /take/start` → expect 404, not 429), not `/api/health`.
4. **Origin Certificate:** SSL/TLS → Origin Server → **"Origin Certificates" tab** (distinct from the "Authenticated Origin Pulls" tab in #2 — two different certs: AOP = the cert CF presents *to* the origin; this = the cert the origin presents *back to* CF) → **Create Certificate** covering `assessiq.in` + `*.assessiq.in`, RSA, 15-year. Place at `/etc/caddy/ssl/assessiq.in.{pem,key}`, `chmod 0600` the key. ⚠️ The dashboard shows the **private key only once** — copy it before closing. If pasted by hand, watch for editor-added leading whitespace/CRLF — PEM with a leading tab fails `openssl` parse (`sed -e 's/\r$//' -e 's/^[[:space:]]*//'` to clean). Verify post-install: `openssl x509 -in …pem -noout -modulus | openssl md5` must equal `openssl rsa -in …key -noout -modulus | openssl md5`.
5. **Google OAuth console:** add `https://assessiq.in/api/auth/google/cb` to the OAuth client's **Authorized redirect URIs** (keep the old one until the redirect is live). Mismatch = SSO fails closed. **Authorized JavaScript origins** can be left **empty** — the flow is server-side (`window.location → /api/auth/google/start → Google → /api/auth/google/cb`), so Google doesn't enforce a JS origin; only the redirect URI matters. (Setting `https://assessiq.in` there is harmless but unnecessary.)

**Staged rollout (order matters — see `infra/caddyfile/assessiq.snippet` header):** Phase 1 add the `assessiq.in` Caddy block alongside the still-serving old block (zero impact); Phase 2 flip the two env vars + redeploy api/worker/frontend; Phase 3 swap the old block to the `redir … permanent` form. Each phase has a smoke gate; the snippet's 4-probe curl set includes the AOP direct-origin-spoof check (must NOT return 200).

**Explicitly NOT included.** (a) `EMAIL_FROM` stays `noreply@automateedge.cloud` — the mail-sender domain move to `noreply@assessiq.in` is a separate workstream (needs SPF/DKIM/DMARC DNS on assessiq.in) and bundling it would risk deliverability. **[Superseded 2026-05-24: that workstream was completed — production now sends from `noreply@assessiq.in`. See "Platform email sender → Resend (2026-05-24)" below.]** (b) No per-tenant custom-domain mapping (still a v2 item). (c) Historical references in PROJECT_BRAIN's decision log and prior session docs are left as-is (record of what was true then).

**Downstream impact.** Embed customers using the CDN `<script src>` must update to `assessiq.in` (embed JWT `allowedOrigins` are tenant-configured separately and unaffected). Any external monitor / uptime check pointed at the old host keeps working via the 301. The `tests/load` PROD_PATTERNS guard now lists `assessiq.in` so load tests stay blocked against the new prod host.

## SEO marketing site — `assessiq-marketing` container (Phase 0, 2026-05-22)

**Status: LIVE & PUBLIC (2026-05-22).** `assessiq.in` now serves the Astro
marketing site (Caddy default route → 9093). The SPA serves `/admin` `/candidate`
`/take` + `/assets/*` `/brand/*` via `@app` (→9091); the API serves `/api/*` etc.
via `@api` (→9092). Verified live: home title = the marketing title; `/admin/login`
+ SPA bundle `/assets/*.js` → 200; `/api/health` → 200; AOP direct-origin spoof →
rejected (000); neighbor `accessbridge.space` → 200; legacy host → 301 → assessiq.in;
`robots.txt` + `sitemap-index.xml` served to a Googlebot UA through Cloudflare.

**What it is.** `apps/marketing/` — a standalone Astro static site, the public
SEO surface. **Phases 1–4 (live 2026-05-23) — 45 indexable pages, 45-URL sitemap:**
P1 = home/about/contact/`/pricing`/`/security` + 4 `/solutions/*` + `llms.txt`;
P2 = `/compare` (3 head-to-head) + `/alternatives` (5) + `/solutions` hub;
P3 = `/glossary` (10 terms) + `/tests` skill library (8 skills);
P4 = `/resources` blog (1 pillar + 2 supporting) + `/methodology`. Plus `robots.txt`,
Header (Solutions/Resources dropdowns + Compare/Skill Tests/Pricing) + grouped Footer.
Full §3.5 head contract; per-page JSON-LD (Organization/WebSite/SoftwareApplication
on home; Service+FAQPage+BreadcrumbList on solutions/tests; Article+FAQPage on
compare/alternatives/resources; DefinedTerm on glossary). No fabricated prices/Offer,
no unearned SOC2/ISO certs, no ratings, no fabricated competitor claims or authors.
New marketing pages need NO Caddy change (they fall to the default→9093 route). Built per
`docs/design/seo-marketing-site-architecture.md` and `docs/design/SEO_Strategy.md`
§17. The React SPA stays the gated app and remains `noindex`.

**Trust pages + Google Safe Browsing remediation (2026-05-23).** Google Search
Console flagged `assessiq.in` with a **"Deceptive pages" (social-engineering)**
Safe Browsing issue (Sample URLs: N/A). **What changed:** added `/privacy`
(DPDP-Act-2023-aligned Privacy Policy) and `/terms` (Terms of Service) as Astro
pages (`apps/marketing/src/pages/{privacy,terms}.astro`, mirroring the
`security.astro` pattern + breadcrumb JSON-LD), linked sitewide from the Footer
"Company" column and added to the **hardcoded** sitemap in `astro.config.mjs`
(45→47 URLs); hardened the SPA login (`apps/web/src/pages/admin/login.tsx`) —
H1 "Sign in to continue." → "Sign in to AssessIQ." + Terms/Privacy links under
the auth buttons — and added Privacy/Terms links to the candidate landing
(`apps/web/src/pages/take/TokenLanding.tsx`). Separately added
`apps/marketing/public/BingSiteAuth.xml` for Bing Webmaster verification.
**Why:** the flag's most probable trigger is the textbook false-positive profile —
a brand-new domain whose login hero CTA is "Continue with Google", with **no
Privacy/Terms anywhere on the site** (Safe Browsing crawls login pages regardless
of `robots.txt` Disallow). Strong self-identification + sitewide legal links are
the standard legitimacy signals that clear it. **Considered & rejected:** Bing's
HTML-meta-tag verification (would inject a tag into all ~45 pages — used the single
XML file instead); requesting the GSC review immediately (held until the hardening
shipped, so the appeal lands on a fixed page, not a repeat-offender cooldown).
**Placeholders filled (2026-05-24, commit on `main`):** entity "AssessIQ", address
Bommanahalli/Bangalore 560068, jurisdiction Bangalore, effective date May 2026. The
grievance section no longer names a dedicated officer or `grievance@` inbox — it routes
to the published `connect@assessiq.in`. `terms.astro` says "based in India" rather than
"a company incorporated under the laws of India" pending confirmation of AssessIQ's
incorporation status (restore the stronger wording if it is a registered company). The
GSC "Request Review" and Bing "Verify" clicks remain operator-gated. **Downstream impact:**
`assessiq-marketing` rebuilt (47 pages) + `assessiq-frontend` rebuilt (login copy);
`docs/04-auth-flows.md` login screen now reads "Sign in to AssessIQ" with legal
links. Commits `657ee2a` (Bing file) + `ab899fe` (trust pages + login hardening),
both on `main`. The note on the **hardcoded sitemap**: any *future* marketing page
is silently absent from `sitemap-0.xml` until added to the `pages[]` array in
`astro.config.mjs` — a known maintenance trap, not auto-discovered.

**Microsoft Clarity analytics (2026-05-24, marketing-site-only).** **What:** added the
Clarity tag (project `wvv1j6k46i`) as an `is:inline` `<script>` in
`apps/marketing/src/layouts/BaseLayout.astro` `<head>`, so it loads on the ~48 marketing
pages and **nowhere else**. **Why marketing-only:** the SPA (`apps/web`, served at
`/admin` `/candidate` `/take`) does NOT use this layout, so Clarity never touches candidate
PII / assessment sessions — required by hard rule (the Privacy Policy states no third-party
analytics on the assessment/admin app, and DPDP forbids unconsented recording of candidate
data). **Do NOT** install Clarity via a Cloudflare zone-level integration or domain-wide GTM
— that would inject it into the SPA too. **Masking:** Clarity dashboard Masking must stay at
Balanced/Strict so the `/contact` form (name/email/message) and any input is masked — a
dashboard setting, not code. **Considered & rejected:** a cookie-consent banner (not yet
added — DPDP leans toward consent for non-essential analytics cookies; flagged as a follow-up).
**Downstream:** `/privacy` cookies section updated to disclose Clarity by name (`_clck`/`_clsk`
cookies, masked session replay) and to reaffirm "no analytics on the app"; `assessiq-marketing`
rebuilt. The Clarity ID is public (ships in page source) — not a secret.

**Container.** `assessiq-marketing` in `infra/docker-compose.yml`: `nginx:alpine`
serving Astro `dist/`, host port **9093:80** (9091=frontend, 9092=api). Dockerfile
at `infra/docker/assessiq-marketing/Dockerfile` (multi-stage; **pnpm pinned to
9.15.0** via `packageManager` — node:22-alpine corepack defaults to pnpm 11 whose
`minimumReleaseAge` policy breaks the frozen install of a 9.x lockfile). Standalone:
`apps/marketing` is EXCLUDED from the pnpm workspace (`pnpm-workspace.yaml`
`!apps/marketing`); own lockfile, installed `--ignore-workspace`.

**Deploy (steady-state):**
```bash
cd /srv/assessiq && git pull --ff-only
docker compose -f infra/docker-compose.yml build assessiq-marketing
docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-marketing
```
Verified 2026-05-22 on :9093 — `/`, `/about`, `/contact`, `/robots.txt`,
`/sitemap-index.xml`, `/favicon.svg`, `/og-default.png` → 200; `/nonexistent` →
**real 404** (Astro `build.format:'file'` + nginx `try_files $uri $uri.html
$uri/index.html =404`, no `$uri/` branch → no soft-404, no trailing-slash 301);
home serves all 3 JSON-LD blocks. Live `assessiq.in` + `accessbridge.space`
confirmed unaffected.

**Asset routing (no collision with the SPA).** The SPA owns `/assets/*` (Vite
chunks) + `/brand/*` (favicons/og). Marketing uses `/_astro/*` + ROOT favicons
(`/favicon.svg` etc.) + `/og-default.png` — deliberately NOT `/assets` or
`/brand`. This is why the `@app` matcher below carries `/assets/* /brand/*`.

**DONE — Caddy flip (live 2026-05-22; `codex:rescue` ACCEPT).** The THREE-WAY split
from `infra/caddyfile/assessiq.snippet` was applied to the `assessiq.in` block in
`/opt/ti-platform/caddy/Caddyfile`:
```caddy
@api  path /api/* /embed* /help/* /take/start /verify/*                 # -> 9092 (unchanged)
@app  path /admin /admin/* /candidate /candidate/* /take /take/* /assets/* /brand/*   # -> 9091 (SPA)
handle { reverse_proxy 172.17.0.1:9093 ... }                            # default -> 9093 (marketing)
```
The live block's directives were already current (only its comments had drifted).
Applied via: backup → **validate** (`docker cp` the candidate file INTO the
container then `caddy validate` — the Caddyfile is bind-mounted as a SINGLE FILE,
so sibling files in `/opt/ti-platform/caddy/` are NOT visible at `/etc/caddy/`)
→ inode-safe truncate-write (`cat new | tee Caddyfile`, NEVER `mv`/`sed -i`)
→ `caddy reload` → smoke gate with auto-revert. Backup:
`Caddyfile.bak.20260522T182634Z`. AOP `client_auth` block left intact.
**Cloudflare injects a Managed-robots block** ahead of our `/robots.txt`
(Content-Signal `search=yes, ai-train=no` + AI-bot Disallows) — expected per
SEO_Strategy §3.1; our app-path Disallows + `Sitemap:` directive are intact below
it. **Rollback:** `cat /opt/ti-platform/caddy/Caddyfile.bak.20260522T182634Z |
tee /opt/ti-platform/caddy/Caddyfile >/dev/null && docker exec ti-platform-caddy-1
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

**Contact-form backend (2026-05-24).** The `/contact` page previously used a `mailto:` form action which opened the visitor's email client — unreliable on mobile and flagged as "not secure" in browser UX. It now submits via AJAX `POST /api/contact` (the `assessiq-api` container, already behind the `@api` Caddy matcher — no Caddy change required). The endpoint is public and unauthenticated; it reuses the existing per-IP credential-tier rate limiter (`authChain({ requireSession: false, credentialEndpoint: true })`) to cap relay abuse. A hidden honeypot field (`company_website`) silently drops bot submissions before they hit SMTP. Email is sent directly (no BullMQ queue — contact enquiries are not tenant-scoped and carry no `email_log` row) via the platform Resend SMTP transport (`resolveTransport()`); `replyTo` is set to the submitter's address so the team can reply inline. Recipient is hardcoded `connect@assessiq.in`. If `SMTP_URL` is unset (local dev), the enquiry is dropped to `webhook.log` with a WARN and the API still returns `200 { ok: true }`. On SMTP error the API returns `502 SEND_FAILED` with a fallback message pointing to the direct email address. No new environment variables or Caddy changes are needed; the feature is fully live once the API container is redeployed.

**Cloudflare Turnstile on the contact form (2026-05-24).** Bot protection beyond the
honeypot. **Frontend** (`contact.astro`): the Turnstile widget
(`data-sitekey="0x4AAAAAADVMWHe1bQPyzyZJ"` — public) + `challenges.cloudflare.com/turnstile/v0/api.js`;
the submit handler reads the `cf-turnstile-response` token, blocks if absent, sends it as
`cf_turnstile_response`, and resets the widget per attempt (single-use). **Backend**
(`/api/contact`): server-side `siteverify` before send — **fail-closed** (missing/invalid
token or siteverify error → `403 TURNSTILE_FAILED`); when `TURNSTILE_SECRET` is unset it
rejects in production and skips only in non-prod. **New env var** `TURNSTILE_SECRET` in
`/srv/assessiq/.env` (widget secret key; root-owned, not in git) — recreate `assessiq-api`
after setting it. Widget = `AssessIQ contact` (Managed) in Cloudflare. Layered with the
honeypot + per-IP credential limiter + global 20/hr budget. **codex:rescue ACCEPT** (after
one REVISE: prod fail-closed on unset secret + confirmed the per-IP limiter runs before the
siteverify call). **Sharp edge:** the backend (turnstile) and frontend (widget) shipped in
*separate* commits — if you ever see the form 403 on every submit, the widget is missing
from the deployed marketing build (frontend not deployed). To rotate the secret: regen in
Turnstile → update `.env` + recreate the API.

> **History (superseded 2026-09-20):** production now sends through Brevo SMTP from `AssessIQ <connect@assessiq.in>`. See the "UPDATE 2026-09-20" block in the env section below and `docs/13-email-system.md`. This Resend record stays as history.

**Platform email sender → Resend (2026-05-24).** The platform's SMTP transport was
switched from a personal **Gmail SMTP** (`smtp.gmail.com`, From `manishjnvk@gmail.com`
— see RCA 2026-05-24) to **Resend**. `assessiq.in` is verified in Resend (DKIM
`resend._domainkey` + SPF/MX on `send.assessiq.in`, added via Cloudflare DNS). On the
VPS, `/srv/assessiq/.env` (root-owned, `600`, **not** in git) now has
`SMTP_URL=smtps://resend:<api-key>@smtp.resend.com:465` and
`EMAIL_FROM="AssessIQ <noreply@assessiq.in>"`. This covers **all** outbound email —
login OTPs + invites (queued via the worker) and contact enquiries (synchronous).
Recreate `assessiq-api` **and** `assessiq-worker` after an `.env` change (env_file is
read at container start). Verified 2026-05-24: OTP + contact both deliver to the Gmail
Inbox From `noreply@assessiq.in`. Rollback: `cp .env.bak.<ts> .env` + recreate. The
Resend API key is a secret — to rotate, create a new key in Resend → API Keys and
re-run the `.env` swap. **Why it mattered:** Gmail-as-sender caused contact enquiries
(which forward to that same Gmail) to be deduped out of the Inbox, and leaked a
personal address as the sender of every OTP/invite; Gmail SMTP also caps ~500/day.

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

### Current live state — Phase 2 AI question generator deployed (2026-05-08)

SOC-grounded AI question generation is live. 70-entry knowledge base (L1/L2/L3), `generate-questions` Claude Code skill, `submit_questions` MCP tool, admin generate-drawer UI with citation chips.

**What changed 2026-05-08 (commits `e04f6e2`–`586e889`, 32 files, 2610 insertions):**
- Migration 0016 applied to `assessiq-postgres`: `questions.status` CHECK includes `'ai_draft'`; `knowledge_base_sources JSONB NOT NULL DEFAULT '[]'` added to `questions` and `question_versions`.
- `modules/04-question-bank/src/knowledge-base/`: soc-l1.json (25), soc-l2.json (25), soc-l3.json (20) KB entries.
- New route: `POST /api/admin/packs/:id/levels/:levelId/generate` (admin-only, single-flight, returns `{ questionIds, generated, skillSha }`).
- `assessiq-api` image **rebuilt** (`docker compose build assessiq-api`) and recreated.
- `generate-questions` SKILL.md at `prompts/skills/generate-questions/SKILL.md` (git-tracked; bind-mounted into container at `/home/node/.claude/skills/generate-questions/SKILL.md`).
- Admin pack-detail page: "✦ Generate" button per level, slide-in drawer with count slider + SOC topic-focus chips, citation chips for `ai_draft` questions.
- Smoke verified: `POST /api/.../generate` (no auth) → **401** ✅

**Deploy procedure for source-only changes (no schema change, no new skill):**
```bash
git pull --ff-only
docker compose -f /srv/assessiq/infra/docker-compose.yml build assessiq-api
docker compose -f /srv/assessiq/infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api
```
`--force-recreate` alone is insufficient — the Dockerfile bakes source into the image, so a rebuild is required on every code change.

**Skill-deploy procedure (when any `prompts/skills/*/SKILL.md` changes):**

> **CHANGED 2026-10-01: prompts are no longer in git.**
> - **Why:** the repo is public, and the grading and generation prompts are product IP, so `prompts/skills/` was untracked and gitignored.
> - **Source of truth:** the VPS host copy at `/srv/assessiq/prompts/skills/`. A local working copy stays on the laptop (ignored), and the daily backup writes `prompts-skills-<ts>.tgz` to `/var/backups/assessiq/`.
> - **Container mount:** unchanged (`../prompts/skills:/home/node/.claude/skills:ro`).
> - **Deploying a skill change:** `git pull` no longer does it. Copy the edited file instead: `scp prompts/skills/<name>/SKILL.md assessiq-vps:/srv/assessiq/prompts/skills/<name>/SKILL.md`. That's the whole deploy (the file is re-read on every call), but still rebuild the api image if the runtime schema changed too, and re-baseline the evals.
> - **One-time cutover (2026-10-01):** the untracking commit makes the next `git pull` on the VPS delete the folder. So back it up before the pull (`cp -a prompts/skills /root/assessiq-skills-backup-<ts>`), restore it right after (`cp -a … prompts/skills`), and then **recreate** api and worker, because the bind mount pinned the deleted directory inode. sha256 of every SKILL.md was checked before and after.
> - **Lint:** `tools/lint-deploy-procedure.ts` CHECK A now treats a missing folder (fresh CI checkout) as normal.
> - The `git pull` steps below are historical.

Skills in `prompts/skills/` are bind-mounted read-only into the `assessiq-api` and
`assessiq-worker` containers at `/home/node/.claude/skills/` (relative path
`../prompts/skills` from `infra/docker-compose.yml`). **Since 2026-10-01 a `git pull` does not deploy skill changes.** Use `scp` to copy the file into `/srv/assessiq/prompts/skills/` on the VPS (see the box above). No container restart is needed for a skill-only change.
The skill file is re-read from disk on every `skillSha()` invocation. *History: before 2026-10-01 a `git pull` alone was enough.*

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

**Claude CLI state mount pattern (2026-05-09, commits `607f636` + `de49d89`):**

The container mounts the entire host claude state as a directory, not per-file.
Two mounts are required:

```yaml
- /root/.claude:/home/node/.claude:rw        # entire state directory
- /root/.claude.json:/home/node/.claude.json:rw  # config file (one level above dir)
```

> **[Update 2026-10-09: superseded by RW-11 (`e8c12cf`).]** The `/root/.claude.json` file bind above is removed. The containers now set `CLAUDE_CONFIG_DIR=/home/node/.claude` and read `/root/.claude/.claude.json` inside the directory mount. The old "restart api and worker after a re-login" rule (a single-file bind follows the inode and goes stale) no longer applies. See the section "Hardening S2 deploy (2026-10-09)".

**Why whole-directory, not per-file:** claude upgrades introduce new state files
(`.credentials.json` was added in v2.1.137; older per-file mounts only listed
`oauth_token`, `oauth_token.expires`, `settings.json` and silently missed it).
Whole-directory mount picks up any new state files automatically without YAML edits.

**Why `USER root`:** `.credentials.json` is mode 600, root-owned. The container must
run as root to read it. The app files are still chowned to node:node inside the image
(`RUN chown -R node:node /app` runs before `USER root`), so the app itself runs fine.
Trust model: single-tenant admin container; node-user isolation adds little real
security when the container already bind-mounts the admin's credential directory.

**`skills/` stays `:ro` overlay:** `../prompts/skills` is overlaid read-only on top
of the `.claude` dir mount so git-pull-only skill deploys still work.

RCA reference: `docs/RCA_LOG.md` 2026-05-09 entry "claude auth state mount: per-file
approach broken across version upgrades".

**MCP tool rebuild procedure (2026-05-11, commit `ab39667`):**

`tools/assessiq-mcp/` is bind-mounted read-only into `assessiq-api` at `/opt/assessiq-mcp`. TypeScript source compiles to `dist/tools/*.js` (one file per tool — **not** into `dist/server.js`). The MCP server is spawned fresh per Claude session, so the new dist is picked up immediately with no container recreate required.

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

The rejection logger writes JSONL to `/var/log/assessiq/mcp-rejections.log` (bind-mounted rw from the VPS host). The file is created on first rejection — absence means no rejections have occurred yet, not a write failure.



`assessiq-api`, `assessiq-worker`, and `assessiq-frontend` are all live. Phase 4 ships the full embed JWT ingestion flow, admin embed origin management, `aiq_embed_sess` cookie bridge, and 4 schema migrations.

**What changed 2026-05-03 (Phase 4 — commit `b20858b`, 34 files, 1743 insertions):**
- Migrations applied directly to `assessiq-postgres`: `0070_embed_origins.sql` (`tenants.embed_origins TEXT[]` + GIN index), `0071_tenants_embed_metadata.sql` (`tenants.privacy_disclosed BOOLEAN` + `sessions.session_type TEXT` + index), `0072_embed_help_seed.sql` (4 help content rows for embed surface), `0073_attempt_embed_origin.sql` (`attempts.embed_origin BOOLEAN` + partial index).
- `assessiq-api` container rebuilt and restarted with new `@assessiq/embed-sdk` package.
- New routes: `GET /embed?token=<JWT>` (full Phase 4 implementation), `GET /embed/health`, `GET /embed/sdk.js`, `POST /embed/sdk-mint` (dev-only, triple-gated by `ENABLE_EMBED_TEST_MINTER=1`), `GET /api/admin/embed-origins`, `POST /api/admin/embed-origins`, `DELETE /api/admin/embed-origins`, `DELETE /api/admin/embed-secrets/:id`, `POST /api/admin/webhook-secrets/rotate`.
- `aiq_embed_sess` ↔ `aiq_sess` cookie bridge active in `onRequest` hook.
- `apps/web` gains `useEmbedMode`, `embedBus`, `EmbedLayout`, and `TakeRoot` patch for embed rendering.
- `packages/embed-sdk/` is the new public host-side npm package (`@assessiq/embed`).
- No Caddy config changes — `/embed*` is already matched by the `@api` path matcher.
- **Env var note:** `ENABLE_EMBED_TEST_MINTER=1` must NOT be set in production (default: unset). The triple gate (`env var + NODE_ENV != 'production' + admin session`) ensures it is safe to leave absent.
- Smoke tests (post-deploy): `GET /api/health` → 200 ✅, `GET /embed` (no token) → 400 ✅, `GET /embed/health` → 200 ✅, `GET /embed/sdk.js` → 200 ✅, `GET /api/admin/embed-origins` (no auth) → 401 ✅.

### E2E test minter (`ENABLE_E2E_TEST_MINTER`) — prod invariant

Added 2026-05-08 alongside the `admin-workflow.spec.ts` Playwright E2E suite. The route `POST /api/dev/mint-session` provides a dev-only way to bootstrap authenticated sessions without Google SSO — enabling E2E tests in CI without interactive OAuth.

**Invariant: `ENABLE_E2E_TEST_MINTER` must be absent (or `"false"`) in `/srv/assessiq/.env` at all times.** The route is not registered at server startup unless the env var is `"true"`, so it physically does not exist in the prod module graph. This is stronger than a runtime 403.

Verification (run after every API deploy):
```bash
curl -I https://assessiq.automateedge.cloud/api/dev/mint-session
# Expected: 404 Not Found (NOT 401 or 200)
```

If the curl returns anything other than 404, the env var is misconfigured. Remove it from `/srv/assessiq/.env` and restart `assessiq-api` immediately.

The env var is intentional on:
- Local dev: `ENABLE_E2E_TEST_MINTER=true pnpm --filter @assessiq/api dev`
- Staging/CI: set on the staging server only, never production

**Update 2026-10-03 (RS11).**
- **Local stack.** `apps/web/e2e/local-stack.sh` starts throwaway `assessiq-e2e-*` Postgres and Redis containers, applies the migrations, and starts the API, the worker and the web dev server with `ENABLE_E2E_TEST_MINTER=true`. `--down` removes exactly those containers. Nothing here touches the VPS.
- **Minter fix (`ac8b8cb`).** The dev minter used `ON CONFLICT (tenant_id, lower(email))`, but no index matched. Every new candidate got a 500. It now uses `(tenant_id, email)`. The Vite dev proxy was fixed in the same commit.
- **CI.** The `e2e` job (`09595fa`) starts its own `postgres` and `redis` services in the runner and does not need the repo variables `E2E_BASE_URL` or `E2E_API_BASE_URL`. **Required since E13 (2026-10-09):** `continue-on-error` was removed after the job was green on seven consecutive runs where it ran (37400230396 to 37893018042; the only red run, 37422949382, failed in `quality` on a handlebars advisory and skipped e2e). A red e2e job now blocks the workflow. Rejected: keeping it advisory until the flaky totp timing test is fixed (that test runs in `quality`, not e2e). Not included: a retry-on-flake step for e2e (Playwright already retries twice in CI). Downstream: `apps/web/e2e/README.md` § Running in CI; `.github/workflows/ci.yml` comment above the `e2e` job.
- **Prod invariant unchanged.** The flag stays absent or `false` in `/srv/assessiq/.env`.

See `apps/web/e2e/README.md` for full local run + CI integration guide.

**Previous state — Phase 3 G3.C analytics module deployed (2026-05-03)**

`assessiq-api`, `assessiq-worker`, and `assessiq-frontend` are all live. Phase 3 G3.C ships 6 new admin analytics routes, `attempt_summary_mv` materialized view, and a nightly BullMQ cron refresh job.

**What changed 2026-05-03 (Phase 3 G3.C — 15-analytics):**
- Migration `0060_attempt_summary_mv.sql` applied — `attempt_summary_mv` MV created (empty, no attempt_scores yet).
- `0011_seed_help_content.sql` re-applied — 8 new analytics help keys inserted via `ON CONFLICT DO NOTHING` upsert.
- `assessiq-api` and `assessiq-worker` containers rebuilt with new `@assessiq/analytics` package.
- 6 new routes: `GET /api/admin/reports/topic-heatmap`, `/archetype-distribution/:id`, `/cost-by-month`, `/exports/attempts.csv`, `/exports/attempts.jsonl`, `/exports/topic-heatmap.csv` — all return 401 unauthenticated (confirmed via smoke-curl).
- No Caddy config changes — all routes are under `/api/*` which is already matched by the `@api` path matcher.

**Previous state — Phase 1 G1.D split-route + frontend (2026-05-03)**

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

### Memory limits and the worker healthcheck (RW-4, 2026-10-09)

**What and why.** Every service in `infra/docker-compose.yml` has a `mem_limit`. `assessiq-worker` has a Redis PING healthcheck. The VPS has 8 GB and other apps use about 3.8 GB of it. A runaway container must not starve them.

| Service | `mem_limit` | Live use at the time |
| --- | --- | --- |
| `assessiq-api` | 2g | 180M |
| `assessiq-worker` | 1g | 184M |
| `assessiq-postgres` | 1g | 32M |
| `assessiq-redis` | 256m | 7M |
| `assessiq-frontend` | 128m | under 4M |
| `assessiq-marketing` | 128m | <4M (nginx) |

**Probe mechanics.** The probe is a Node stdlib one-liner. It opens a TCP socket to the host and port of `REDIS_URL`. It sends PING and expects PONG. Timeout is 3 s. Interval is 30 s, retries are 3, start_period is 20 s.

> [!WARNING]
> Do not write `\r\n` in a double-quoted YAML scalar that holds code. YAML turns it into real CR and LF characters and the JS string breaks. Use `'PING'+String.fromCharCode(13,10)`. Run `docker compose config --format json` to see the parsed command.

**Rejected.** `redis-cli` and `wget` are not in the `node:22-slim` image. An HTTP probe does not work because the worker has no port.

**Not included.**
- A cap for the whole stack. The caps sum to 4.5 GiB, so they bound each service only.
- A process-liveness probe. The PING proves Redis is reachable. A wedged worker still reads healthy. `restart: unless-stopped` covers a crash.
- Redis 256m is the tightest cap because of the AOF rewrite. Raise it if the AOF grows.

**Impact.** Recreate every service after you edit `mem_limit`. `docker restart` does not apply a new limit. Use `up -d --no-deps --force-recreate <svc>`, one service at a time.

**Verify.**
1. Run `docker inspect -f '{{.HostConfig.Memory}}' <container>` for each service. The value is in bytes.
2. Run `docker inspect -f '{{json .State.Health}}' assessiq-worker`. Status is `healthy` and the last log `ExitCode` is 0.

## .env template — `/srv/assessiq/.env`

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

# Rate limiting — optional; Zod defaults are 100/30/30/600 req/min/IP per tier.
# Set only to tune for your traffic; zero-config deploy works without any of these.
# RATE_LIMIT_IP_ADMIN=100     # admin/reviewer session: 100 req/min/IP
# RATE_LIMIT_IP_USER=30       # candidate session:       30 req/min/IP
# RATE_LIMIT_IP_ANON=30       # anonymous (no session):  30 req/min/IP
# RATE_LIMIT_IP_APIKEY=600    # API-key callers:        600 req/min/IP
```

**Local development:** the same keys live in `.env.local` at the repo root (gitignored — `.gitignore` covers `.env.*` with `!.env.example` allowlist). Never commit values; only `.env.example` is in the repo.

## Email sender (Resend cutover)

> **History.** Production moved from Resend to Brevo on 2026-09-20. The sender is now `AssessIQ <connect@assessiq.in>`.

> **SUPERSEDED (2026-05-24).** This is the original 2026-05-21 *plan*, which targeted
> `automateedge.cloud`. The cutover was actually executed on 2026-05-24 against
> **`assessiq.in`** (verified in Resend via Cloudflare DNS) with sender
> `AssessIQ <noreply@assessiq.in>` — see **"Platform email sender → Resend (2026-05-24)"**
> above for the as-built record. The steps below are retained for reference; substitute
> `assessiq.in` for `automateedge.cloud` throughout.

Production should send mail through Resend, not a personal Gmail. As of 2026-05-21 the live `.env` was still set to `smtps://manishjnvk@gmail.com:<app-password>@smtp.gmail.com:465` — this leaks the operator's personal Gmail in the From: header AND fails DMARC against `assessiq.automateedge.cloud`, pushing transactional mail toward spam.

**Sender identity (zero-budget):** `AssessIQ <noreply@automateedge.cloud>` — root domain is already owned (it's the parent of `assessiq.automateedge.cloud`). No new domain registration. If/when `assessiq.in` is later registered, the same Resend account verifies it as a second domain in 5 minutes; only the `EMAIL_FROM` env var needs to change.

**Why Resend:** free tier covers 3,000 emails/month and 100/day; uses standard SMTP so `modules/13-notifications/src/email/transport.ts` works unchanged; deliverability backed by Resend's IPs + DKIM signing on our domain.

### One-time setup (off-platform)

1. **Sign up** at `resend.com` with `manishjnvk@gmail.com`. Free tier — no card.
2. **Add domain** → enter `automateedge.cloud`. Resend lists 4 DNS records to add: 1 × MX (return-path), 1 × TXT-SPF, 2 × TXT-DKIM. (Or use the subdomain `assessiq.automateedge.cloud` for reputation isolation from neighbor apps on the shared VPS — see `CLAUDE.md` rule #8. Subdomain choice does NOT require changing the Zod default in `modules/00-core/src/config.ts` immediately; the env var override is sufficient.)
3. **Add the DNS records** at the registrar for `automateedge.cloud` (Hostinger DNS — log in to `hpanel.hostinger.com` → Domains → `automateedge.cloud` → DNS). Copy the Host / Type / Value fields verbatim from Resend. Wait ~10 min for propagation, click **Verify** in Resend until all 4 records turn green.
4. **(Recommended) Add a DMARC record** — TXT at `_dmarc.automateedge.cloud`:

   ```text
   v=DMARC1; p=none; rua=mailto:manishjnvk@gmail.com; pct=100; adkim=s; aspf=s
   ```

   `p=none` = report-only; nothing gets bounced. Tighten to `p=quarantine` later once volumes settle.
5. **Generate SMTP credentials** in Resend dashboard → SMTP tab → create new credential. Resend returns a connection string of the form `smtps://resend:re_XXXXXXXX@smtp.resend.com:465`. Store the API key in a password manager.

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

1. **Smoke test.** From AssessIQ admin UI, invite a sandbox email address to a sandbox assessment.
2. **From: header.** Open the received mail in Gmail → "Show original" → confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`, and `From: AssessIQ <noreply@automateedge.cloud>`.
3. **Resend dashboard.** The send appears in **Emails** with status `delivered`.
4. **Log grep on the VPS.** `docker logs assessiq-worker --since 5m | grep -i "from:"` shows no `manishjnvk@gmail.com` references.
5. **Per-tenant override unaffected.** `select id, smtp_config from tenants where smtp_config is not null;` — any tenant-level overrides still take priority via `resolveFromAddress()` in `modules/13-notifications/src/email/transport.ts`.

### Post-cutover security hygiene

**Revoke the leaked Gmail app-password.** The Gmail app-password used pre-cutover was committed to `.env.local` (gitignored, but present in the live VPS file and any local working copies). After the Resend swap is verified:

1. `myaccount.google.com` → Security → 2-Step Verification → App passwords.
2. Find the entry matching the AssessIQ relay; click the trash icon.
3. The old credential stops working immediately; any forgotten copies in dev environments stop being a risk.

### Limits & follow-ups

- **Resend free tier daily cap = 100 emails.** Cohort blasts >100/day will bounce the 101st. Monitor in the Resend Emails tab; bump to the $20/mo tier (50K/mo, 1K/day) the first time it bites.
- **In-flight queue.** Emails enqueued in BullMQ *before* the env swap still carry the old From:. Drain the queue (or accept a few minutes of mixed senders) before declaring the cutover complete.
- **DNS records — record them here.** Once the 4 Resend records + DMARC are live, append a row per record to the DNS table below for future operator reference.

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

## Deploy key — `assessiq-vps`

The VPS authenticates to GitHub using an Ed25519 deploy key at `~/.ssh/github_deploy` (read-only access to `manishjnv/assessIQ`).

| Field | Value |
| --- | --- |
| Key file | `~/.ssh/github_deploy` (private), `~/.ssh/github_deploy.pub` (public) |
| Fingerprint | `SHA256:HXZm4e6xgZjd1h++/CxJUpl8mcH4/raA1kg/Ci+peYk` |
| GitHub URL | https://github.com/manishjnv/assessIQ/settings/keys |
| SSH config stanza | `Host github.com-assessiq` → `~/.ssh/config` on the VPS |
| Access | **Read-only** — sufficient for `git pull`; write access intentionally NOT granted |
| Added | 2026-05-03 via `gh repo deploy-key add` (RCA closure — see `docs/RCA_LOG.md` 2026-05-03) |

**Rotation:** generate a new ed25519 key (`ssh-keygen -t ed25519 -f ~/.ssh/assessiq_deploy_new -N ''`), add to GitHub Settings → Deploy Keys, update `~/.ssh/config` `IdentityFile` line, verify `ssh -T git@github.com-assessiq`, remove old key from GitHub, delete old key file.

## Pre-deploy lint gates

> **Added 2026-05-08.** These CI lints run on every PR in `.github/workflows/ci.yml` (deterministic-gates job, steps 8–12). They catch the "code shipped, operational dependency missed" class of bugs that caused repeated production incidents between 2026-05-03 and 2026-05-08. See `docs/RCA_LOG.md` for the originating incidents.

Run locally before opening a PR:

```bash
pnpm tsx tools/lint-deploy-procedure.ts
```

Or run a specific check via `--json` for machine-readable output, and `--self-test` to validate the lint itself.

### CHECK A — Skill bind-mount integrity

**What it catches:** Skill files under `prompts/skills/<name>/SKILL.md` that exist in the repo but are not bind-mounted into the `assessiq-api` and `assessiq-worker` containers in `infra/docker-compose.yml`. Also detects the inverse: a mount declared in docker-compose but the `prompts/skills/` directory contains no `SKILL.md` files.

**Why it exists:** On 2026-05-08, the question-generator feature was blocked for hours because the `prompts/skills/` directory was not mounted into the container — the skills were on the VPS host but invisible inside the running API. The fix required 3 commits and a compose rebuild.

**Canonical fix for violations:**
- `SKILL UNREACHABLE`: Add a read-only bind-mount in `infra/docker-compose.yml` under `services.<name>.volumes` mapping `../prompts/skills` to the skills directory inside the container. See the existing `assessiq-api` volumes block for the correct pattern.
- `SKILL MOUNT EMPTY`: Either add `SKILL.md` files under `prompts/skills/<name>/` or remove the dead bind-mount.

### CHECK B — Migration apply chain

**What it catches:** SQL files anywhere under `modules/` or `apps/` that are NOT at the exact depth `modules/<name>/migrations/<file>.sql` — the only path pattern discovered by `tools/migrate.ts`. A SQL file at `modules/foo/subdir/migrations/001.sql` is invisible to the runner and will never be applied, silently leaving the schema stale.

**Why it exists:** Migration files added to non-standard paths (e.g., in a subdirectory or under `apps/`) will be committed without error and appear in git history, but will never be applied at deploy time. The schema diverges from the code silently.

**Canonical fix for violations:**
- `MIGRATION ORPHAN`: Move the file to `modules/<name>/migrations/<basename>.sql` so the runner discovers it, OR add the exemption marker at the top of the file: `-- DEPLOY: manual; not part of migration sequence` and document the manual apply step in this doc under § Migrations.

**Exemption marker** (for seed files, reference data, or ad-hoc fixes applied out-of-band):
```sql
-- DEPLOY: manual; not part of migration sequence
-- Reason: <explain why this SQL is not part of the automated migration sequence>
```

### CHECK B.2 — Migration-drift gate (`pnpm tsx tools/migrate.ts --check`)

**What it catches:** A `.sql` migration file exists in the repo under
`modules/*/migrations/` but is **not recorded in the live DB's
`schema_migrations` table**, OR a recorded migration's stored checksum no
longer matches the on-disk file's content. Both states block a clean deploy:
the first means the deployed code expects a table/column/index that doesn't
exist; the second means the file was edited after it was applied, which
silently fragments history across environments.

**Why it exists:** RCA `2026-05-13 — Verify path silently 404/500 in prod`.
Migrations `0046_certification_init.sql` (Phase 5 Session 1, 2026-05-11) and
`0074_public_verify_policy.sql` (Phase 5 Session 3) were committed and the
Fastify code that depended on them was deployed, but neither migration was
ever applied to the VPS DB. The certificates table didn't exist for two
sessions; every `/verify/*` request returned HTTP 500 in prod, masked
because nothing in the user-facing app actually linked to `/verify/*` yet.
A pre-deploy `--check` would have failed loud and refused to ship.

**How to run** (requires postgres-superuser `DATABASE_URL` — the
`assessiq_app` role used by the running API cannot write `schema_migrations`):

```bash
DATABASE_URL='postgres://postgres:…@host:5432/assessiq' \
  pnpm tsx tools/migrate.ts --check
```

Exit 0 → repo and `schema_migrations` are in sync; safe to deploy.
Exit 1 → at least one pending migration **or** at least one drifted
checksum. The JSONL log lists each offending file under
`migration.check.pending` / `migration.check.drift` events. Resolve before
proceeding to `docker compose build` / `up -d`.

**Canonical fix for violations:**
- `migration.check.pending`: run `pnpm tsx tools/migrate.ts` (no `--check`)
  against the same `DATABASE_URL` to apply the missing migration(s). Then
  re-run `--check` to confirm exit 0.
- `migration.check.drift`: a recorded migration was edited after it was
  applied. This is almost always a mistake (migrations are append-only).
  Investigate before proceeding. If the edit is genuinely intentional (rare
  — e.g. a typo-only fix in a comment), use `--force-rerun <basename>`
  against the affected DB to re-record the new checksum. Otherwise revert
  the edit so the on-disk content matches what was applied.

### CHECK C — Env var declaration coverage

**What it catches:** `process.env.VAR_NAME` reads in `modules/*/src/` and `apps/*/src/` where `VAR_NAME` does not appear anywhere in `.env.example` (including comment mentions). This catches vars that are used in code but never documented for operators provisioning a new environment.

**Why it exists:** On 2026-05-08 the SMTP email feature was delayed because `SMTP_URL` was not provisioned on the VPS — it was in the config schema but operators didn't know to set it. This check ensures every env var consumed by the codebase is visible in `.env.example`.

**Standard skip list** (not flagged): `NODE_ENV`, `HOME`, `PATH`, `USER`, `HOSTNAME`, `SHELL`, `CI`, `GITHUB_ACTIONS`, `PORT`, and other standard Node/OS/CI variables. See `SKIP_ENV_VARS` in `tools/lint-deploy-procedure.ts`.

**Canonical fix for violations:**
- `ENV VAR UNDECLARED`: Add a placeholder entry to `.env.example`:
  ```
  # VAR_NAME — short description of what this variable controls.
  # Example: VAR_NAME=example-value  (or leave blank if it's a secret)
  VAR_NAME=
  ```
  If the variable is truly optional with a sensible default, also declare it in `modules/00-core/src/config.ts` as `z.optional()` or `z.default(...)`.

### CHECK D — Email template URL ↔ SPA route consistency

**What it catches:** Two patterns:
1. HTML email templates (`modules/13-notifications/src/email/templates/*.html`) with hardcoded `href="/path/..."` attributes that don't match any `<Route path="...">` entry in `apps/web/src/App.tsx`.
2. Email-sending service code (modules 03, 05, 13) that constructs URL paths via template literals (`${base}/path/${segment}`) or string concatenation where the path prefix has no matching SPA route.

**Why it exists:** On 2026-05-04 (RCA: "candidate invitation URL /invite/ vs /take/"), `modules/05-assessment-lifecycle/src/service.ts` built invitation links as `${PUBLIC_URL}/invite/${token}`. The SPA has no `/invite/:token` route — candidates clicked the link and landed on the 404 page. The fix was a 1-line change but required diagnosing from a live email log.

**Canonical fix for violations:**
- `TEMPLATE URL MISMATCH`: Either fix the URL path in the template / service code to use a registered SPA route (check `apps/web/src/App.tsx`), OR add the missing route to the SPA. The fix should be made in BOTH places if the route was intentionally omitted — don't patch the URL around a missing route.

---

## Deploy procedure (steady-state, post-2026-05-03)

As of 2026-05-03 `/srv/assessiq` is a `git clone` of `manishjnv/assessIQ`. The old `git archive + scp + tar-extract` rsync flow is **deprecated** — see RCA 2026-05-03 "Architectural debt: /srv/assessiq is not a git clone". All future deploys use:

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
diff /tmp/repo-migrations.txt /tmp/db-migrations.txt || {
  echo "MIGRATION DRIFT — apply pending or reconcile before deploying"; exit 1; }

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

> **Why step 2 is mandatory:** RCA `2026-05-13 — Verify path silently 404/500 in prod`. Migrations `0046_certification_init.sql` and `0074_public_verify_policy.sql` were committed and the dependent code was deployed across multiple sessions, but neither migration was ever applied. The verify feature was silently 500ing in prod for two sessions before a Session 7 smoke surfaced the gap. A pre-deploy diff between `ls modules/*/migrations/*.sql` and `SELECT version FROM schema_migrations` would have caught it immediately. Treat step 2 as a hard gate, not a courtesy check.

**If `.env` changes:** use `up -d --force-recreate` (NOT `restart`) — see RCA 2026-05-01 "docker compose restart does NOT reload env_file".

**Smoke after every deploy:**
```bash
ssh assessiq-vps 'docker ps --format "{{.Names}} {{.Status}}" | grep assessiq'
curl -sI https://assessiq.automateedge.cloud/api/health  # expect HTTP/2 200
# Verify no restart-loop: docker logs --tail 20 assessiq-api 2>&1 | grep -i 'syntaxerror\|module.*does not provide'
```

**NOTE:** `/srv/assessiq.old` (pre-conversion rsync copy) preserved at `/srv/assessiq.old` until 2026-05-10 for rollback safety. Safe to `rm -rf` after that date.

## First-boot bootstrap (`/srv/assessiq/`)

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

# 5. Append the AssessIQ Caddyfile block (see "Reverse-proxy plan" above)
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

After bootstrap: log in at `https://assessiq.automateedge.cloud/admin/login`, complete TOTP enrollment, the platform is live.

## Backups — `/etc/cron.daily/assessiq-backup`

> **Status (2026-10-01): INSTALLED and verified.** Until this date, the cron described here existed only in this doc. The VPS had no backup job, no `/var/backups/assessiq` and no rclone (see RCA 2026-10-01 "Documented DB backups were never installed").

**What runs (live copy on the VPS; this is the source of truth; a byte-identical copy is kept in the repo at `tools/ops/assessiq-backup.sh` — redeploy with `scp tools/ops/assessiq-backup.sh assessiq-vps:/etc/cron.daily/assessiq-backup` then `chmod 755`; no secrets inside, it reads `SMTP_URL` from `/srv/assessiq/.env` at runtime):**
- **Schedule and dump:** `/etc/cron.daily/assessiq-backup` runs as root once a day (run-parts, about 06:25 server time). It runs `docker exec assessiq-postgres pg_dump -U assessiq -d assessiq -Fc` to write `/var/backups/assessiq/assessiq-<UTC-ts>.dump`. The custom format is already compressed, so there is no gzip. The directory is 0700 and each file 0600.
- **Integrity check:** the new archive must pass `pg_restore -l` before it replaces the temp file.
- **Retention:** 14 days, deleting only `assessiq-*.dump` files inside that directory.
- **Log:** one line per run in `/var/log/assessiq/backup.log`, `OK <file> <bytes>` or `FAIL rc=… line=…`.
- **Failure alert:** an `ERR` trap emails `connect@assessiq.in` (which forwards to the owner's Gmail). It uses `curl` with the app's own `SMTP_URL` from `/srv/assessiq/.env` (Brevo), with no extra account. The alert path was tested on 2026-10-01 and delivered.
- **Offsite:** the owner-enabled **Hostinger weekly VPS backup**, which captures `/var/backups/assessiq`. Worst-case data loss is about 1 day if the disk survives and up to about 7 days if the whole VPS is lost.
- **Prompt skills (added 2026-10-01 b):** each run also tars `/srv/assessiq/prompts/skills` to `prompts-skills-<ts>.tgz` (14-day retention). The prompts are gitignored, so this tarball plus the host copy are the only copies besides the owner's laptop. If the folder is missing, the run emails an alert.
- **Known ceiling (`ponytail`):** if the cron daemon itself stops, nothing alerts. Add an external dead-man ping (healthchecks.io) if that matters. rclone/R2 offsite (the original design below) was not adopted; add it if RPO must be under 7 days for VPS loss.

**Restore drill, 2026-10-01: PASSED.**
- **Setup:** a throwaway `assessiq-restore-drill` container (`postgres:16-alpine`, `--network none`), `pg_restore --no-owner --no-privileges`.
- **Result:** 0 errors. Row counts matched live exactly: tenants 6, users 11, questions 337, attempts 5, gradings 8, audit_log 941.
- **Cleanup:** the container was removed afterwards.

Drill command pattern (read-only against live; only the drill container is created and removed):

```bash
IMG=$(docker inspect -f '{{.Config.Image}}' assessiq-postgres)
docker run -d --rm --name assessiq-restore-drill --network none \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=assessiq -e POSTGRES_DB=assessiq "$IMG"
DUMP=$(ls -t /var/backups/assessiq/assessiq-*.dump | head -1)
docker exec -i assessiq-restore-drill pg_restore -U assessiq -d assessiq --no-owner --no-privileges < "$DUMP"
# compare counts of tenants/users/questions/attempts/gradings/audit_log vs assessiq-postgres, then:
docker rm -f assessiq-restore-drill
```

**Secrets are not in the dump.** `MASTER_KEY` and the rest of `/srv/assessiq/.env` must be kept separately (owner's password manager). Without `MASTER_KEY`, encrypted columns can't be read after a restore.

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

## Diagnostics — generation_attempts inspection

Use inspect-attempt to surface the full diagnostic state of a generation_attempts row when a smoke run exits non-zero without a visible root cause (e.g., log_analysis and scenario chunks silently fail with exit-1):

```bash
docker exec -w /app/modules/07-ai-grading assessiq-api \
  pnpm exec tsx /app/modules/07-ai-grading/eval/cli-typed.ts inspect-attempt \
  --attempt-id 019e0deb-4dcf-70b1-83fe-8c88e20b7b62 \
  --show-stderr --show-questions
```

Or via the local wrapper (requires SSH access to ssessiq-vps):

```bash
bash tools/inspect-attempt.sh 019e0deb-4dcf-70b1-83fe-8c88e20b7b62
```

The --show-stderr flag prints the 1024-byte-truncated stderr_tail column — the primary signal for diagnosing chunk-level subprocess failures that are not otherwise visible. --show-questions prints each inserted question's contentKeys and knowledgeBaseSourceIds, useful for verifying MCP gate output. The command is read-only and exits 0 on success, 2 on attempt-not-found or DB error.


## Operational hygiene

Recurring ops sweeps keep the `questions` and `generation_attempts` tables
clean between smoke campaigns and deploys. See `tools/README.md` for the
full catalog, including argument reference and example invocations.

Key scripts:

- **`tools/cleanup-stale-drafts.ts`** — bulk-archive `ai_draft` questions older
  than N days (default 7). Run weekly or after every smoke campaign.
- **`tools/cleanup-orphaned-attempts.ts`** — mark `running` generation attempt
  rows older than N minutes (default 30) as `failed` with `error_code='ORPHANED'`.
  Run hourly or after any deploy that may have killed in-flight generation.

Both scripts default to **dry-run** (print-only); pass `--apply` to write.
Both use `SET LOCAL ROLE assessiq_system` for cross-tenant access.

---

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

---

## Applying new migrations by hand (pattern used 2026-10-01)

`tools/migrate.ts` is not run against production today: older migrations were applied by hand, and `schema_migrations` is incomplete (some rows are missing; 0100 and 0106 are recorded without `.sql`), so `migrate.ts --check` would flag drift. New migrations are applied one by one, in number order, **before** the image rebuild, because new code may read the new columns (for example 0119 `attempt_questions.option_order` is read by `saveAnswer`).

1. **Pull:** `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
2. **Script:** write a small LF-only bash script on the laptop, `scp` it to `/tmp`, and run it with `ssh assessiq-vps 'bash /tmp/<script>.sh < /dev/null'`.
   - Do NOT pipe the script into `ssh … bash -s`: the `docker exec -i` inside it swallows stdin, and the run silently stops after the first command.
3. **One transaction per file, then record it:**
   ```bash
   PSQL="docker exec -i assessiq-postgres psql -U assessiq -d assessiq"
   $PSQL -1 -v ON_ERROR_STOP=1 -q < modules/<NN-module>/migrations/<file>.sql
   sha=$(sha256sum <that file> | cut -d' ' -f1)
   $PSQL -tA -c "INSERT INTO schema_migrations(version, checksum) VALUES ('<file>.sql', '$sha') ON CONFLICT DO NOTHING RETURNING version;"
   ```
4. **Post-checks in the same script:** new columns via `information_schema.columns`, new policies via `pg_policies`, and help-row counts. Then build and recreate as in the steady-state procedure:
   - `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`;
   - `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`. The worker uses the api image.
5. **Before recreating:** make sure no AI grading run is in flight. `docker exec assessiq-api sh -c "ps -o args | grep -v grep | grep -c claude"` must print `0`.

**Quoting gotcha:** SQL containing `$$` or nested quotes inside `ssh '…'` is mangled by the remote shell (`$$` becomes the shell's PID). Put the SQL in a file and pipe it into `psql` (`docker exec -i … psql … < /tmp/q.sql`).

Applied this way on 2026-10-01:
- 0113–0116: scoring and result release, evaluation queue;
- 0117–0121: invitation resend, help, option shuffle, notifications UPDATE policies.

See `docs/plans/SCORING_RESULT_RELEASE.md` and `docs/plans/PILOT_READINESS_BATCH.md`.

## Public "Try a sample test" demo — `/try` (apps/web, 2026-10-02)

**What:** `/try` (SPA page, no `RequireSession`) and `/try/certificate` (static SAMPLE certificate). Fixed bundled content, client-side deterministic scoring, **zero network requests** (no API, DB, email or AI). Code: `apps/web/src/pages/try/`. OG image: `apps/web/public/brand/social/try-og.png` (+ `.svg` source) served at `/brand/social/try-og.png`. It must NOT live under `public/try/`: a `try/` folder makes the frontend nginx treat `/try` as a directory (301 → 403); hit and fixed 2026-10-02. Marketing home links to it.

**Why not `/verify/...` for the sample certificate:** `/verify/*` is in the `@api` matcher (to the API). The demo page must be SPA-served, so it lives under `/try/`.

**Edge change APPLIED 2026-10-02 (owner-approved).** `/try /try/*` was added to the shared Caddy `@app` matcher of the `assessiq.in` block, which now reads:
```caddy
@app  path /admin /admin/* /candidate /candidate/* /take /take/* /try /try/* /assets/* /brand/*
```
Procedure: backup `Caddyfile.bak.20261002T034840Z` next to the Caddyfile, validate in the container, inode-safe truncate-write (no `mv`, so the bind mount keeps its inode), reload. Additive only; no other site block touched. Mirror kept in `infra/caddyfile/assessiq.snippet`. `pnpm lint:edge-routing` needs no change (it checks Fastify mounts only). Live check: `/try` 200.

**Bug hit and fixed (RCA 2026-10-02).** The first build put the OG image in `apps/web/public/try/`. A real `try/` folder in the frontend nginx root makes `/try` a directory: 301 then 403, so the SPA never loaded. Fixed in `e426760` by moving the image to `public/brand/social/try-og.png`. Rule: never create a folder under `apps/web/public/` named like an SPA route.

**Known limit:** the SPA serves one static `index.html`, so a shared `/try` link unfurls with the default AssessIQ OG image; link crawlers do not run JS. To unfurl with `/brand/social/try-og.png`, give `/try` its own static HTML (or a Caddy rewrite) later.

**Rollback:** remove `/try /try/*` from `@app`; the page then 404s via marketing and the home CTA should be reverted.


## Batch 4 deploy (2026-10-02, HEAD `e752be6`)

**Migrations applied by hand** (same procedure as batch 2/3, before recreating api/worker/frontend):
- 0132: `attempt_questions.section_index`, `attempts.section_progress` (test sections, 06).
- 0133: help rows for test sections and calculator (16).
- 0134: `assessment_invitations.reminded_at` (invitation reminders, 05).
- 0135: help row `admin.assessment.reminders` (16). Help rows total 175 after this batch.

**Edge:** Caddy `@app` gained `/try /try/*` (see the `/try` section above; backup `Caddyfile.bak.20261002T034840Z`).

**New worker job: `invitation.reminders`.** Registered as a BullMQ repeatable in `apps/api/src/worker.ts` (every 30 min, `attempts: 1`; handler `apps/api/src/jobs/invitation-reminders.ts`, logic in 05 `reminders.ts`). It is NOT an AI job; the worker's stale-repeatable cleanup keeps it by name. Limits: 25 emails per tick, 100 per trailing 24 h across the platform, bulk email lane. Does nothing unless an assessment has `settings.reminders.enabled`. Verify: the repeatable `invitation.reminders` is listed in the worker queue; rollback: untick per assessment, or remove the registration. See `docs/plans/INVITATION_REMINDERS.md`.

**New boot requirement:** production refuses to start unless `ORIGIN_TRUST_MODE=enforce` (04 batch 4 notes). Prod already runs enforce; api and worker were confirmed after the recreate.

**Post-deploy checks (all passed):** `/api/health` 200; `/try` 200; `POST .../finish-section` and `PATCH .../reminders` return 401 logged out; `invitation.reminders` repeatable registered; 175 help rows; api and worker env `ORIGIN_TRUST_MODE=enforce`; 0 api/worker errors in logs.


## Batch 5 deploy (2026-10-02, HEAD `27f6357`; commits `21502db..27f6357`) — DONE

**Migrations applied by hand** (same procedure as "Applying new migrations by hand", before recreating api/worker/frontend). All are additive:
- 0136: help rows, sections follow-ups (16).
- 0138: help rows, high-stakes grading (16).
- 0140: view `grading_override_quality` (07). Needs roles `assessiq_app` and `assessiq_system` to exist for the GRANTs (it skips a missing role).
- 0141: help rows, eval gate (16).
- 0142: table `generation_batches` with RLS (07).
- Numbers 0137 and 0139 do not exist (skipped); apply only the five files above.

**Before recreating the api container** (the compose file now bind-mounts a host dir):
```bash
ssh assessiq-vps 'test -d /srv/assessiq/.git || echo "WARNING: not a git clone"'
ssh assessiq-vps 'mkdir -p /srv/assessiq/modules/07-ai-grading/eval/baselines'
```
Without `mkdir -p`, Docker creates the dir root-owned. The mount is read-write on purpose: `bless` runs inside the api container and writes there. The dir is gitignored and survives container recreates.

**New env (api):** `AI_EVAL_GATE` (`off` | `warn` | `enforce`), default `warn` from compose. Leave it at `warn` at deploy. Do not set `enforce` until a baseline is blessed, or all AI grading returns 409 `AIG_EVAL_GATE`.

**Eval bootstrap (inside the api container, on the VPS, `/srv/assessiq`).** Run it in the container so the skills mount and Claude login match live grading. A host run would hash `/root/.claude/skills`, which may differ, and the gate would never match. `runs/` is container-local, so do all three steps before recreating the container.
```bash
mkdir -p modules/07-ai-grading/eval/baselines
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts run --mode claude-code-vps
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts compare --run <ISO>
docker exec -e AIQ_ADMIN_USER_ID=<super-admin-uuid> assessiq-api pnpm tsx modules/07-ai-grading/eval/cli.ts bless --run <ISO>
```
Only then set `AI_EVAL_GATE=enforce` in `.env` and recreate `assessiq-api`. Every later skill edit repeats run, compare, bless. The golden set is about 1 case today (N5); grow it first for a meaningful gate.

**Deploy steps** (additive only, `assessiq-` namespace): `git pull` in `/srv/assessiq`; apply the migrations; `mkdir -p` the baselines dir; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each.

**Post-deploy checks (all passed 2026-10-02):**
- Result: 5 migrations applied and recorded in `schema_migrations`; view present, 2 RLS policies on `generation_batches`, help rows 175 → 181; no `claude` process in flight before recreate; only `assessiq-api`, `assessiq-worker`, `assessiq-frontend` recreated, 24 containers running before and after (neighbours untouched); api/worker 0 error lines; api env `AI_EVAL_GATE=warn`, `ORIGIN_TRUST_MODE=enforce`; baselines dir mounted.
- In-container gate check (`tsx` script calling `getEvalGateStatus()`): `{"mode":"warn","approved":false,"current":{"anchors":"30a419e9","band":"e2460dec","escalate":"ec6e9925"},"baseline_date":null}` — the live skill shas the first bless must match.
- `/api/health` 200, `/try` 200; the four new routes 401 logged out.
- Super admin: `GET /api/admin/super/eval-gate` returns `mode: "warn"` and `approved: false` (until a bless); `GET /api/admin/super/grading-quality` returns 200.
- `GET /api/admin/generation-batches/active` returns `{batch:null}`; 401 when logged out.
- `PATCH /api/admin/assessments/:id/grading` returns 401 when logged out.
- Help rows count increased (migrations 0136, 0138, 0141).

**CI side (no deploy action):** the new "Test (apps/api)" and audit steps run on GitHub. The audit shows 17 high advisories (N4).

**Rollback:**
- Code: `git checkout <previous sha>` on the VPS, rebuild and recreate api, worker, frontend.
- Migrations: additive; the old image ignores the table, the view and the help rows. Per-file rollback notes are in each migration header (drop `generation_batches`; drop view `grading_override_quality`).
- Gate: set `AI_EVAL_GATE=off` in `.env` and recreate `assessiq-api`.
- The baselines mount can stay.


## Batch 6 deploy (2026-10-02, HEAD `c214ef1`; commits `c1583a6..c214ef1`) — DONE

**Migrations applied by hand** (same procedure as "Applying new migrations by hand"): 0143 only, help row `admin.assessment.sections.edit` (16). Additive; recorded in `schema_migrations`. Help rows 181 → 182.

**Env notes:**
- `.env.example` now declares `AI_EVAL_GATE` and `AIQ_EVAL_BASELINES_DIR`. An empty `AIQ_EVAL_BASELINES_DIR=` line means unset (default `modules/07-ai-grading/eval/baselines`); since `2c66be6` the gate treats empty as unset. Leave it empty unless `eval/cli.ts` is changed to honour it too (N9): the CLI always writes to `eval/baselines`.
- `ENABLE_EMBED_TEST_MINTER` is now declared in 00-core config. It must stay unset or false in prod; blank `ENABLE_*_TEST_MINTER=` lines count as unset. Prod `.env` was checked: `NODE_ENV=production`, `ENABLE_E2E_TEST_MINTER=false`, embed flag absent.
- No other new env. `AI_EVAL_GATE` stays `warn` (no baseline blessed yet).

**Deploy steps** (additive only, `assessiq-` namespace): `test -d /srv/assessiq/.git`; `git pull` (27f6357 → c214ef1); apply 0143; confirm no `claude` process in flight; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each. Dependencies changed (fastify 5.12.x, nodemailer 10), so the images were rebuilt from the new lockfile.

**Post-deploy checks (all passed 2026-10-02):**
- 24 containers before and after; only `assessiq-api`, `assessiq-worker`, `assessiq-frontend` recreated; api/worker 0 error lines.
- In-container versions: nodemailer 10.0.13, fastify 5.12.5.
- SMTP `transporter.verify()` OK against Brevo (no mail sent).
- `/api/health` 200, `/try` 200, `/admin` 200; a malformed JSON POST returns 400.
- Help rows 182.

**Not clicked in a browser:** Edit sections. Owner check: draft assessment → Edit sections → change → save; a published assessment shows the button disabled.

**Rollback:**
- Code: `git checkout 27f6357` on the VPS, rebuild and recreate api, worker, frontend.
- 0143 is help rows only; the old image ignores them.
- Dependencies: the code checkout restores the previous lockfile; rebuild gives the previous image (or retag the previous image).

## Batch 7 deploy (2026-10-02, HEAD `05beab3`; commits `c89b326..05beab3`) — DONE

**Migrations:** none.

**New mounts (compose, `635f3fb`):** `../modules/07-ai-grading/eval/cases-private` and `../eval/runs` are bind-mounted rw into `assessiq-api` (both gitignored). Host dirs must exist before `up`: `mkdir -p /srv/assessiq/modules/07-ai-grading/eval/{cases-private,runs,baselines}`. `eval/cli.ts` now honours `AIQ_EVAL_BASELINES_DIR` (empty = default), the same rule as `eval-gate.ts` (N9).

**NODE_ENV is required (`b7373af`, N8):** `modules/00-core/src/config.ts` has no default; boot fails if unset. Prod sets it in `.env` and the api Dockerfile `ENV`; vitest.setup sets `test`; `.env.example` has `development`. Host or laptop runs of tools (`aiq-import-pack.ts`, `cleanup-*.ts`, `migrate.ts`) now need `NODE_ENV` set (fail closed).

**Dockerignore (`05beab3`):** `.dockerignore` excludes `eval/cases-private`, `eval/runs/*/` and `eval/baselines/*.json`, so a VPS build never bakes the golden set into image layers.

**Golden set:** the 150 cases (300 files) were copied to `/srv/assessiq/modules/07-ai-grading/eval/cases-private` (chmod 700). They are never in git (owner decision: the repo is public). See `docs/05-ai-pipeline.md` § Eval golden set.

**Deploy steps** (additive only): `test -d /srv/assessiq/.git`; `git pull` (c214ef1 to 05beab3); host dirs present; confirm no `claude` in flight; `docker compose -f infra/docker-compose.yml build api worker frontend`; `up -d --no-deps --force-recreate` each. Dependencies changed (React 19.3, Vite 8, jose 6, minor group), so images were rebuilt from the new lockfile.

**Post-deploy checks (all passed 2026-10-02):**
- 24 containers before and after; only api, worker, frontend recreated; api/worker 0 error lines.
- `NODE_ENV=production` in the container; jose 6.2.12.
- 300 case files visible in the container through the mount; the fresh image has NO `cases-private` (dockerignore works).
- `/`, `/admin`, `/try`, `/api/health` 200.
- Served vendor-react chunk is React 19.3.0 with no ES2021+ syntax (the pinned build target is honoured).

**Eval bootstrap (owner, N5 finish):** inside the api container run eval run, compare, bless (commands in § Batch 5 deploy; `runs/` now survives recreates). Check `run.json` `case_count` = 151 (150 + 1 sample). Then set `AI_EVAL_GATE=enforce` in `/srv/assessiq/.env` and recreate `assessiq-api`. A full run grades about 151 cases through Claude Code on the Max login: expect a long run and subscription quota use.

**Not verified in a browser:** Edit sections hidden on a published test; candidate pages under React 19 on an older Chrome.

**Rollback:** `git checkout c214ef1` on the VPS, rebuild and recreate api, worker, frontend. The new mounts are harmless to the old image. No migrations to undo.

**Warning:** never run `git clean -fdx` on the VPS: it would delete `cases-private`, `runs` and `baselines` (all gitignored).

## Rollback and staging (E8, 2026-10-02)

**What changed:** a written rollback procedure and a staging decision. Nothing was created on the VPS.

**Rollback of a bad deploy (code only)**
1. On the VPS: `cd /srv/assessiq && git log --oneline -5`. Pick the last good SHA.
2. `git checkout <prev-sha>` (detached HEAD is expected).
3. Rebuild the changed services: `docker compose -f infra/docker-compose.yml build <svc>` (api, worker, frontend, marketing as needed). The worker uses the api image.
4. Recreate only those services: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate <svc>`.
5. Verify: `/`, `/admin`, `/api/health` return 200 and `docker logs --tail 50 assessiq-api` shows no errors. Make sure no AI grading run is in flight before recreating api or worker.
6. When the fix has landed on main: `git checkout main && git pull --ff-only`, then deploy normally. Do not leave the VPS on a detached HEAD.
7. Never run `git clean -fdx` there: it deletes gitignored `cases-private`, `runs`, `baselines` and `prompts/skills`.

**Migrations are forward-only.** Today they are applied by hand, one transaction per file, and recorded in `schema_migrations` (see the section "Applying new migrations by hand"). Files live in `modules/*/migrations/`. There are no down migrations.
- **Rolled-back build meets a newer schema, additive migration** (new table, new nullable column, new index, new policy): leave it. The old code ignores it. This is the normal case.
- **Destructive or incompatible migration** (drop, rename, type change, NOT NULL without default, tightened CHECK or policy): do not hand-edit the schema. Write a numbered compensating migration, review it, apply it by the same by-hand procedure, then roll back the code. A destructive migration should name its compensating migration in its header before it is deployed.
- **Last resort: restore from backup.** The nightly `pg_dump -Fc` is in `/var/backups/assessiq/` (script `/etc/cron.daily/assessiq-backup`, repo copy `tools/ops/assessiq-backup.sh`, 14-day retention, plus the Hostinger weekly VPS backup). See the section "Backups" for the restore-drill command and "Disaster recovery" for the full restore. A restore loses everything written after the dump (RPO about 24 h) and needs the `.env` secrets (including `ASSESSIQ_MASTER_KEY`) from the owner's password manager.

**Staging: NOT built.** A second compose project (`docker compose -p assessiq-staging ...`) is not purely additive on this shared VPS. Evidence from `infra/docker-compose.yml` and the Caddyfile:
- Every service has a hard-coded `container_name` (`assessiq-postgres`, `assessiq-api`, ...). A second project would collide with production on start, or would need every name changed.
- Host ports `9091`, `9092`, `9093` are fixed and Caddy routes to them. Staging needs three new ports, a new Caddy host block, a new Cloudflare record and an origin cert. A new hostname is new shared-edge surface (the Caddyfile belongs to ti-platform).
- The network is named `assessiq-net`. Volumes are `assessiq_pgdata` and `assessiq_redis` under the compose project name, and `./postgres/init` and `../secrets` are shared paths. These need care to avoid touching prod data.
- The api runs Claude Code under the owner's Max login. A staging api would share that quota and OAuth session.
- Staging would need its own scrubbed database, its own `.env`, and its own AOP and origin-verify setup.

If staging is wanted later, build it off-box (a local compose run using `tools/test-support/apply-all-migrations.ts`) rather than on the shared VPS. Until then, the pre-deploy gates (section "Pre-deploy lint gates") plus a fast rollback are the safety net.

**NOT included:** down migrations, blue/green, automated rollback.

## MASTER_KEY rotation (E8)

**Owner go-ahead required before running on prod.** Nothing in this section was run against production. It was proven only on a throwaway test database (`modules/01-auth/src/__tests__/master-key-rotation.test.ts`).

**What it protects.** Env var: `ASSESSIQ_MASTER_KEY` (base64, 32 bytes, validated in `modules/00-core/src/config.ts`). Cipher: AES-256-GCM, 12-byte nonce. Encrypted columns (the complete list; `TARGETS` in `tools/rotate-master-key.ts` must match):

| Table.column | Layout | Code |
|---|---|---|
| `user_credentials.totp_secret_enc` (BYTEA) | nonce, ciphertext, tag | `modules/01-auth/src/totp.ts`, `crypto-util.ts` |
| `embed_secrets.secret_enc` (BYTEA) | nonce, ciphertext, tag | `modules/01-auth/src/embed-jwt.ts` |
| `webhook_endpoints.secret_enc` (BYTEA) | iv, tag, ciphertext | `modules/13-notifications/src/webhooks/crypto.ts` |
| `tenant_settings.webhook_secret` (TEXT, base64) | nonce, ciphertext, tag | `modules/12-embed-sdk/src/webhook-secret-service.ts` (write only) |

`tenants.smtp_config.password_enc` is described in a migration comment but no code writes or reads it. Recovery codes are hashes, not encrypted. The older "Secret rotation procedure" row lists some column names that do not exist; this section is the correct list.

**Dual-key support.** Optional `ASSESSIQ_MASTER_KEY_PREVIOUS`. Decrypt tries the current key, then the previous key. Encrypt always uses the current key. With it unset, behaviour is unchanged. A wrong key cannot return wrong plaintext because GCM authentication fails.

**Procedure**
1. Take a fresh backup and confirm it: run `/etc/cron.daily/assessiq-backup` as root, then `tail -1 /var/log/assessiq/backup.log`.
2. Generate the new key: `openssl rand -base64 32`. Store it in the password manager now. Confirm the old key is stored there too.
3. In `/srv/assessiq/.env`: set `ASSESSIQ_MASTER_KEY_PREVIOUS=<old value>` and `ASSESSIQ_MASTER_KEY=<new value>`. Edit with truncate-write, not `mv`.
4. Make sure no AI grading run is in flight. Recreate api and worker: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker`. Check `/api/health`. Everything still works: old rows decrypt through the fallback.
5. Dry-run (writes nothing, prints counts only): `docker exec assessiq-api pnpm exec tsx /app/tools/rotate-master-key.ts`. Expect `undecryptable=0` on every line. If not zero, stop: the old key value is wrong or a row is corrupt. Nothing was written.
6. Apply: `docker exec assessiq-api pnpm exec tsx /app/tools/rotate-master-key.ts --apply`. It is safe to re-run. Each batch is one transaction under `SET LOCAL ROLE assessiq_system`.
7. Verify: run the dry-run again. Expect `would_rotate=0` and `already_new=total` on every line. If any line shows `would_rotate>0` (a row written under the old key while the sweep ran — the pass-2 cursor cannot see rows inserted behind it), run `--apply` again and repeat this check. Never do step 8 until every line is zero (codex review 2026-10-02). Then do a TOTP login with an enrolled admin and list embed secrets.
8. Remove `ASSESSIQ_MASTER_KEY_PREVIOUS` from `.env`. Recreate api and worker again. Repeat the check in step 7.
9. Keep the OLD key offline in the password manager for at least 30 days. Any backup taken before the rotation needs the old key to read its encrypted columns (dump retention is 14 days, plus the weekly Hostinger backup). Delete it only after every older backup has aged out.

**Rollback during the procedure.** Before step 8 both keys work. Put the old key back as `ASSESSIQ_MASTER_KEY`, set the new one as `ASSESSIQ_MASTER_KEY_PREVIOUS`, recreate, and re-run `--apply` to rotate back. Restoring a pre-rotation dump needs the old key.

**Not included:** automatic scheduling, rotation of `SESSION_SECRET` (a different key; rotating it logs everyone out), per-tenant keys.

**Downstream impact:** `modules/00-core/src/config.ts` (new optional var), `modules/01-auth/src/crypto-util.ts` and `modules/13-notifications/src/webhooks/crypto.ts` (decrypt fallback), `.env.example`. If a new encrypted column is ever added, add it to `TARGETS` in `tools/rotate-master-key.ts` or rotation will strand it.

## Marketing site: page dates and IndexNow (F1/F4/F5, batch 8, 2026-10-02)

**Page dates.** Sitemap `lastmod` and JSON-LD `datePublished`/`dateModified` come from `apps/marketing/src/data/page-dates.json`. The Docker build context has no `.git` (`.dockerignore`), so the dates cannot be computed at build time. The JSON is generated from git history and committed:

1. Edit a marketing page and commit it.
2. Run `node apps/marketing/scripts/page-dates.mjs` and commit the updated JSON.
3. The build fails if a sitemap URL has no entry (`astro.config.mjs` throws).

**IndexNow ping (after every marketing deploy).** Key file: `https://assessiq.in/51c5d2964f070d2482eecaaa2ef236e7.txt` (public by design). Run `node apps/marketing/scripts/indexnow-submit.mjs` from the laptop. It reads the live `sitemap-0.xml`, posts all URLs to `api.indexnow.org`, prints the HTTP status, and exits non-zero on a non-2xx response. `--dry-run` prints the payload only.

**Rejected:** computing dates at build time (no `.git` in the image); adding `.git` to the build context (large, and leaks history into the build); a new sitemap package (the inline integration exists because `@astrojs/sitemap` 3.x crashes with `trailingSlash: 'never'`).

## Batch 8 deploy (2026-10-02, HEAD `6336f61`; commits `dcded5e..6336f61`) — DONE

**Migrations:** 0144 (`questions_type_check` adds `ordering`) and 0145 (help rows), applied by hand and recorded in `schema_migrations`. Help rows 182 to 185.

**Two stages (additive only):**
1. Marketing first, at `d0977eb`: `git pull`, build and recreate `marketing` only. 24 containers before and after, healthy. Then `node apps/marketing/scripts/indexnow-submit.mjs`: HTTP 202, 54 URLs. Live sitemap has per-page `lastmod` (7 pages 2026-05-23, 1 page 05-24, 45 pages 10-01, 1 page 10-02; the 45 share one site-wide edit date in git).
2. Pull to `6336f61`. Confirm no `claude` process in flight (0). Apply 0144 and 0145 by hand. Build api, worker, frontend. `up -d --no-deps --force-recreate` each.

**Post-deploy checks (all passed):**
- 24 containers before and after; 0 error lines in the api logs.
- `/`, `/pricing`, `/try`, `/admin`, `/api/health`, `/take/x` return 200.
- `questions_type_check` includes `ordering`; help rows 185.
- Admin bundle contains "Move item"; the api image scorer has ordering.
- `claude` processes: 0.

**New in this batch (other sections of this file):** § Rollback and staging, § MASTER_KEY rotation (live key NOT rotated), § Marketing site: page dates and IndexNow. `infra/caddy/assessiq.caddy` is a reference copy only; the live file stays in `/opt/ti-platform/caddy/Caddyfile` (shared container `ti-platform-caddy-1`).

**Not verified in a browser:** the ordering question flow (author, take, score). Behavioural check pending the operator (N12).

**Rollback:** use the code rollback procedure in § Rollback and staging with the previous SHA (`dcded5e`): rebuild and recreate api, worker, frontend, marketing. Migrations 0144 and 0145 are additive (a new CHECK value and help rows), so an older build ignores them. Ordering questions authored after the deploy would not render on an older build.

## RS1–RS5 + N10–N12 deploy (2026-10-02, HEAD `c788ed7`; commits `274bbc6..c788ed7`)

Work in this deploy: candidate-facing fixes (RS1, `0d02ea9`), scenario mcq options (`ac531c5`), text and brand on admin screens (RS2, `578c0aa`), help text (RS3, `8113192`, `8cc46c2`), docs truth pass (RS5, `f40400c`), argon2 0.45.1 (N10, `48e1cfb`) and the mocked browser spec (N12, `c788ed7`).

**Migrations:** 0146 (`modules/16-help-system/migrations/0146_update_help_text_corrections.sql`) and 0147 (`0147_help_text_corrections_followup.sql`). Both change help text only. Each is applied by hand with `psql -1 -v ON_ERROR_STOP=1` and recorded in `schema_migrations`. 0146 updates the global v1 row of each changed key, adds `INSERT … ON CONFLICT DO NOTHING` for it, and inserts the 10 new keys. It is idempotent. 0147 corrects two rows that exist only in older module migrations (`admin.grading.rerun`, `admin.integrations.embed-origins.add`). Help rows: 185 to 195.

### Stage 1 — help text, candidate fixes and admin text

1. Confirm no `claude` process runs (0).
2. `git pull` on `/srv/assessiq`: `6336f61` to `8cc46c2`.
3. Apply 0146 and 0147 by hand.
4. Check: 195 help rows, 0 duplicate global keys, no tenant override rows, no row with version other than 1.
5. Run the check query. Expect 0 rows with internal words: `SELECT count(*) FROM help_content WHERE tenant_id IS NULL AND (long_md ~* '(opus|sonnet|wipro|anthropic|claude)' OR short_text ~* '(opus|sonnet|wipro|anthropic|claude)');`
6. Build `assessiq-api` and `assessiq-frontend`.
7. Recreate `assessiq-api`, `assessiq-worker` and `assessiq-frontend` with `up -d --no-deps --force-recreate`.

Marketing was not rebuilt: no marketing change.

**Post-deploy checks (all passed):**
- 24 containers before and after; api and frontend healthy; 0 error lines in the api and worker logs.
- `/`, `/pricing`, `/try`, `/admin`, `/admin/login`, `/candidate/login`, `/api/health` and `/take/x` return 200.
- Live `index.html` links `/brand/favicon/app.webmanifest` and `https://assessiq.in/brand/social/app-og.png`.
- The manifest returns `"name": "AssessIQ"` with `application/manifest+json`. The PNG is 28,044 bytes, `image/png`.
- The live bundles contain "valid for 7 days", "Single-use link · valid 7 days", the four corrected help ids, "Plan & usage", "Where to find results", "Find your licensed sets" and "up to 1,000 rows".
- The api image has the new sanitizer lines.
- `claude` processes: 0.

**Static files of the app:** a new static file of the web app goes under `/brand/` or `/assets/`. The shared Caddy `@app` matcher routes only `/admin*`, `/candidate*`, `/take*`, `/try*`, `/assets/*` and `/brand/*` to the app. A file in the `public/` root goes to the marketing site and returns 404. See `docs/08-ui-system.md`.

**Not verified in a browser on production:** the admin authoring screen for ordering questions, server scoring on a real backend, publish and the admin view. The mocked Playwright spec `apps/web/e2e/take-runner-mocked.spec.ts` covers the candidate runner only (3 tests pass). CI does not run it. Behaviour check pending the operator.

**Rollback:** use the code rollback procedure in § Rollback and staging with the previous SHA (`6336f61`): rebuild and recreate api, worker, frontend. Migrations 0146 and 0147 change help text only and need no rollback, because an older build reads the same rows.

### Stage 2 — API image with argon2 0.45.1

Pull `8cc46c2` to `c788ed7`. `claude` processes: 0. Built `assessiq-api` only; recreated `assessiq-api` and `assessiq-worker` (`up -d --no-deps --force-recreate`). The frontend was not rebuilt (no frontend change in this stage).

**Checks (all passed):**
- 24 containers before and after; api healthy; 0 error lines in the api and worker logs; `/api/health` 200.
- `argon2` in the image: `0.40.3` before, `0.45.1` after. The prebuilt glibc binary loads on `node:22-slim`; no Dockerfile change.
- In the container, a hash made by 0.40.3 verifies with 0.45.1, and a wrong input is rejected (the same fixture as `modules/01-auth/src/__tests__/argon2-compat.test.ts`).

**Rollback:** rebuild the api image at `8cc46c2` and recreate api and worker. Hashes made by 0.45.1 use the same algorithm and cost parameters, but the stored string lists the parameters as `m,p,t` (0.40 wrote `m,t,p`). Before a rollback, check that 0.40.3 verifies a hash made by 0.45.1; this direction was not tested.

## Small tasks deploy: RV16, N13 to N18 (2026-10-03, HEAD `38c76e3`; commits `62e01d8..38c76e3`)

Work in this deploy: dashboard counts from the server (`511e1af`), scenario answer check at save (`e6eb22d`), small admin items and comment cleanup (`4ea20a8`), page help for eight admin pages (`2a15ce5`), and Astro 5 for the marketing site (`38c76e3`). Detail for each change: `docs/plans/SMALL_TASKS_N13_N18_RV16.md`.

**Migration:** 0148 (`modules/16-help-system/migrations/0148_seed_page_help.sql`). It inserts eight help rows (`<page>.page`) and changes nothing else. It is idempotent (`ON CONFLICT DO NOTHING`). It was applied by hand with `psql -1 -v ON_ERROR_STOP=1` and recorded in `schema_migrations`.

**Procedure (one stage, additive only):**

1. List the containers: 24 run. Confirm that no `claude` process runs (0).
2. `git pull --ff-only` on `/srv/assessiq`: `62e01d8` to `38c76e3`.
3. Apply 0148 by hand and record it. Global help rows: 195 to 203.
4. Check: 8 new page keys present, 0 duplicate global keys, 0 rows with internal words (the check query from the RS1–RS5 deploy).
5. Build `assessiq-api`, `assessiq-frontend` and `assessiq-marketing`. All three builds exit with 0. The marketing image builds with Astro 5.18.2 on `node:22`; the Dockerfile and the compose file did not change.
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
- No IndexNow ping. No marketing page content or page date changed; only the build tools changed.
- No click test in a browser with an admin sign-in. `GET /api/help` and the dashboard queue need a session. Behaviour check pending operator: dashboard cards, the "no access" notice, the (?) help drawer on the eight pages.

**Rollback:** `git revert` the commit of the item, then rebuild and recreate the service. Module 06 or 07: api and worker. Admin pages: frontend. Marketing: revert `38c76e3`, rebuild and recreate `assessiq-marketing`. Migration 0148 needs no rollback: an older build does not read the eight rows. To remove them: delete the eight `<page>.page` keys (`tenant_id IS NULL`) and the `schema_migrations` row `0148_seed_page_help.sql`. A frontend older than `511e1af` works with the new API (it ignores `counts`); the new frontend works with an older API (it falls back to the list length).

## Review-fix deploy wave A: N20, N22, E10, RS9 (RV62, RV63, RV64), RS8 (RV58, RV59), SP7 structured_case, E9 splits, FR17 gate (2026-10-03, HEAD `5f073f0`; commits `3911f8b..5f073f0`)

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

Each file ran with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. Each was then recorded with `INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (<basename>, now(), <sha256sum of the file>) ON CONFLICT DO NOTHING`.

**Pre-deploy check (read-only):** the clone is on `main` and clean at `3911f8b`. 24 containers run (6 `assessiq-*`, 18 others). Migrations are applied up to 0148 (79 rows). Global help rows: 203. Disk 54 % used. Load 0.3. Health returns 200.

**Procedure (one stage, additive only):**

1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`: `3911f8b` to `5f073f0`.
3. Confirm that no `claude` process runs (0).
4. Apply 0149, 0150, 0152 and 0153 by hand in that order, and record each one. Global help rows: 203 to 207.
5. Check the database. 13 rows are under `admin.tenant_settings.%` and `admin.question.editor.%`. The index `attempts_dashboard_count_idx` exists. `questions_type_check` includes `structured_case`.
6. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`. The build exits with 0. Use the service names with the `assessiq-` prefix. A first try with `api` and `frontend` did nothing. Marketing is not rebuilt because it did not change.
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

**Rollback:** `git revert <sha>` for the item. Then rebuild and recreate the service. Modules 04, 05, 06, 07, 09, 02, 14 and the api routes: `assessiq-api` and `assessiq-worker`. Module 10 and the web app: `assessiq-frontend`. Migration 0150: `DROP INDEX IF EXISTS attempts_dashboard_count_idx` (harmless). Migration 0152: do not revert the CHECK while a `structured_case` row exists. Migration 0149: run the reverse UPDATE of the eight keys. Migration 0153: delete the four keys. Delete the `schema_migrations` rows that you reverse.

## Review-fix deploy wave B: RV60 reviewer role removed (2026-10-03, HEAD `636c970`; commits `5f073f0..636c970`)

Work in this deploy, in commit order:
- `7accd3f` RV77: CSV export guards.
- `ac8b8cb` dev session minter fix and Vite proxy (dev only).
- `09595fa` RS11: e2e tests and the CI job (CI only).
- `4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573` RV60: the reviewer role is removed (migration 0154).
- `0efd0f9..ad4a835` N19: six commits of development-tool updates (no production effect).
- `a951e5a` lockfile from the branch tip.
- `0ef50d9` the submit action flushes the pending autosave before `POST /submit`.
- `636c970` docs and the `Adversarial-Review:` trailer.

**Migration (one, applied by hand):** 0154. The file ran with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. It was then recorded in `schema_migrations` with the file checksum and `ON CONFLICT DO NOTHING`. Before the deploy, production had 0 reviewer users and 0 open reviewer invites.

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

**Checked:** one global help row (`admin.users.role`) still contains the word "reviewer" on purpose: its text says there is no reviewer role. No follow-up.

**Not done:**
- Marketing is not rebuilt in either wave. No IndexNow ping.
- No click test in a browser. Behaviour check pending operator: the Settings (?) help, the question editor with a structured case, the attempts tab "Awaiting evaluation", and the preview of a published assessment.

**Rollback:** `git revert` the commits of RV60, then rebuild and recreate `assessiq-api`, `assessiq-worker` and `assessiq-frontend`. Migration 0154: read the file first, reverse its statements by hand, and delete its `schema_migrations` row.

## Review-fix deploy wave A (session q): RS10, FR2, FR4, FR13, FR25, RS4 code, N23 to N26 (2026-10-03, HEAD `7e2af3d`)

Work in this wave: `e645d81` (CI only), `9a111e1` (FR2 `onCommit`, module 02 and 14), `eafeeac` and `7e2af3d` (FR4 embed JIT), `6638494` (FR13 web), `b5fa76a` (FR25 modules 04 and 08), `9b541ba` (RS4, marketing: not built). No migration.

**Procedure (additive only, no migration):**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker assessiq-frontend`.
4. Run `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Result:** the three services were recreated and are healthy. 8 routes return the expected status.
**Not in this wave:** the marketing container (RS4 text waits for owner approval) and the IndexNow ping.
**Rollback:** `git revert <sha>` of the item, then rebuild and recreate the same three services.

## Review-fix deploy wave B: N23, N24, N25, N26 (2026-10-03, HEAD `ef01da2`, deployed at `ef01da2`)

Work in this wave: `4ad6cc0` (N23, migration 0155, help seed), `00a951e` (N25), `f1c0aa0` (N26), `34abc0e`, `c58438a`, `9b585a7` (N24: shared AES core and Lua script), merges `54557e9` and `ef01da2`.

**Migration (one, applied by hand, as in the earlier waves):** 0155 (`modules/16-help-system/migrations/0155_help_ids_page_prefix_n23.sql`). It only renames and copies `help_content` keys; there is no schema change. Run it with `docker exec -i assessiq-postgres psql -U assessiq -d assessiq -1 -v ON_ERROR_STOP=1 -q < file`. Then record it in `schema_migrations` with the file checksum and `ON CONFLICT DO NOTHING`. Global help rows go from 200 to 203.

**Procedure:**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Apply 0155 by hand and record it.
4. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-worker assessiq-frontend`.
5. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**N24 note.** The stored layouts of encrypted values are unchanged, so no data migration and no re-encryption run. A rollback of the code needs no data step.

**Result:** **Wave B result (verified 2026-10-03):** clone at `ef01da2`; migration 0155 applied by hand (`psql -1 -v ON_ERROR_STOP=1`) and recorded in `schema_migrations` with its sha256; old keys left: 0; global help rows: 210. api, worker and frontend rebuilt and recreated; api healthy; 0 error lines in api and worker logs; routes: / 200, /api/health 200, /admin/login 200, /take/x 200, /api/auth/whoami 401, /embed?token=x 401. CI green on `ef01da2` (quality + e2e).

**Rollback:** `git revert` the commits, then rebuild and recreate the three services. For 0155: read the file, then reverse the renames by hand (the old keys never loaded text).

## Deploy 2026-10-03 (session r): FU-B6, FU-C17, N21, RV71 to RV74, N3, E4, RS4/PT1 marketing (HEAD `90a9ddb`)

Work in this deploy: `f9473d5` (RV27), `67919ce` (page dates), `e11cb5b` (PT1-6 terms section 7), `60477e0` (N3), `e65b993` and `90a9ddb` (RV73), `f0884bd` (FU-C17), `28ab66f` and `5b02fa1` (FU-B6), `74f1f46`, `ea906d4` (RV71, RV74), `94fdc4a` (N21, migration 0156), `9084a53`, `6ed8ded`.

**Marketing.** The `assessiq-marketing` container was rebuilt twice: after RV27, then after PT1-6. After each build the IndexNow ping returned HTTP 200 for 42 URLs. The sitemap has 42 URLs because the 12 coming-soon pages are `noindex` since RS4.

**Migration (one, applied by hand).** `0156` (`modules/04-question-bank/migrations/0156_question_versions_type_n21.sql`) ran with `psql -1 -v ON_ERROR_STOP=1`. It is recorded in `schema_migrations` with its sha256. Result: 169 `question_versions` rows, 0 NULL types, 0 type mismatches.

**Procedure.**
1. Run `git push` for `main` as its own command.
2. Run `ssh assessiq-vps 'cd /srv/assessiq && git pull --ff-only'`.
3. Apply 0156 by hand and record it.
4. Run `docker compose -f infra/docker-compose.yml build assessiq-api assessiq-frontend`.
5. Run `up -d --no-deps --force-recreate assessiq-api assessiq-worker assessiq-frontend`.

**Result (verified 2026-10-03).** VPS at `90a9ddb`. 24 containers before and after. `/` 200, `/api/health` 200, `/admin/login` 200, `/take/x` 200, `/api/auth/whoami` 401, `/embed?token=x` 401, `/terms` 200. 0 error lines in the api and worker logs.

**Skill deploy (E4/G4).** `generate-subjective/SKILL.md` version `2026-10-03a`, deployed by `scp` (see 05). Backup `/root/assessiq-skills-backup-20261003/`.

**Not deployed or not run.** The RV73 backup check is NOT installed (steps below). The FU-C17 audit is NOT run: `ssh assessiq-vps 'docker exec assessiq-api pnpm exec tsx tools/audit-rubrics.ts'` (read-only). No offsite backup (R8).

**Rollback.**
- Code: `git revert <sha>`, then rebuild and recreate the three services.
- Migration 0156 (only before any code depends on it): `DROP TRIGGER question_versions_default_type ON question_versions;` `DROP FUNCTION question_versions_default_type();` `ALTER TABLE question_versions DROP CONSTRAINT question_versions_type_check;` `ALTER TABLE question_versions DROP COLUMN type;` then delete the `0156` row in `schema_migrations`. If the `94fdc4a` code runs, revert the code first.
- Skill: copy the backup file back and restart api and worker.
- Marketing: revert the commit, rebuild `assessiq-marketing`, send IndexNow again.

### RV73 backup check: install steps (owner, not done)

Files: `tools/ops/assessiq-backup-check.sh` (dead-man check; self-test with 11 cases), `infra/systemd/assessiq-backup-check.service`, `infra/systemd/assessiq-backup-check.timer`. The check reports STALE when the newest dump is old or has a future mtime. It needs a heartbeat service account (the owner chooses it).

1. Copy the script to `/usr/local/sbin/assessiq-backup-check.sh` (owner `root:root`, mode 0755).
2. Put the heartbeat URL in an `EnvironmentFile` (`/etc/assessiq/backup-check.env`, owner `root:root`, mode 0600).
3. Option A, cron: add one line to `/etc/cron.d/assessiq-backup-check` that runs the script after the nightly backup.
4. Option B, systemd: copy the two unit files to `/etc/systemd/system/`, run `systemctl daemon-reload`, then `systemctl enable --now assessiq-backup-check.timer`. Touch only `assessiq-*` units.
5. Run the script once by hand and check that it prints OK.

Do the enumerate-first checks of project rule 8 before step 1.

### `GET /api/ready` readiness probe (RW-9)

`GET /api/ready` answers whether the API can run AI evaluation now. It needs no login.

- **Checks.** Three checks run in parallel, each with a 5 s timeout: `db` (`SELECT 1`), `redis` (`PING`), `claude` (`claude --version`, no shell).
- **Response.** `{ "status": "ready" | "not_ready", "checks": { "db": bool, "redis": bool, "claude": bool } }`. The status is 200 when all checks pass and 503 when one fails. The body holds no versions and no error text.
- **Cache.** The `db` and `redis` results are cached for 5 s. The `claude` result is cached for 60 s. Concurrent requests share one run. A caller cannot start more than one process each minute.
- **Why no login.** The body holds only booleans, and the process cost is capped by the cache. A monitor can call it without a secret.
- **Use.** Point an uptime monitor at it next to `/api/health`. `/api/health` stays a pure liveness check. The platform evaluation page shows the result as a chip.

## Hardening S2 deploy (2026-10-09)

**What changed.** Commit `4b2fe39` (RW-7, RW-8, RW-9) and commit `e8c12cf` (RW-11). Both are pushed. The VPS is at `e8c12cf`.

### Deploy of `4b2fe39`

1. `git pull` in `/srv/assessiq`.
2. Apply migration 0164 by hand (`psql -1`). Record it in `schema_migrations` with its sha256. It adds the help rows for the evaluation runtime chip (global help rows +1).
3. Build `assessiq-api`, `assessiq-worker` and `assessiq-frontend`.
4. Recreate each one with `up -d --no-deps --force-recreate`.

**Result.** No claude process was in flight before the recreate. 24 containers before and after. 0 error lines in the api and worker logs. `/api/health` 200, `/api/ready` 200, `/admin/login` 200. Live check: `https://assessiq.in/api/ready` returns `200 {"status":"ready","checks":{"db":true,"redis":true,"claude":true}}`.

**Redis is now required for AI.** `single-flight.ts` fails closed with `503 AIG_LOCK_UNAVAILABLE` when Redis is down. If AI calls return this 503, check `docker ps` for `assessiq-redis` and `/api/ready` first. The Redis `mem_limit` is still 256m (see SESSION_STATE open questions). Details: `docs/05-ai-pipeline.md` D7.

**Not included.** No abort of a running claude subprocess when the lease is lost. No lock on the rubric-draft and answer-guidance-draft calls. No uptime monitor yet (B2: owner signup). RW-10 (eval bless and `AI_EVAL_GATE=enforce`) is NOT done; it waits for the owner to run the eval (about 151 cases).

**Rollback of `4b2fe39`.** `git revert 4b2fe39`, rebuild the three services, recreate them. Migration 0164 only adds help rows; leave it in place.

### RW-11: `CLAUDE_CONFIG_DIR` replaces the single-file `.claude.json` bind (`e8c12cf`)

**What.** In `infra/docker-compose.yml`, `assessiq-api` and `assessiq-worker` no longer bind `/root/.claude.json:/home/node/.claude.json:rw`. Both set `CLAUDE_CONFIG_DIR=/home/node/.claude`. The claude CLI now reads `$CLAUDE_CONFIG_DIR/.claude.json`, which sits inside the existing `/root/.claude` directory mount.

**Why.** A single-file bind follows the inode. When the host CLI rewrote `/root/.claude.json` (for example at `/login`), the container kept the old file until a restart. A directory mount shows the new file at once.

**Host steps done.**
1. Backups: `/root/.claude.json.bak-20261009` and `/root/docker-compose.yml.bak-20261009-rw11`.
2. Seed the new file: `cp -a /root/.claude.json /root/.claude/.claude.json`.
3. `up -d --no-deps --force-recreate assessiq-api assessiq-worker`.

**Verified.** Both containers healthy. 24 containers before and after. `claude mcp list` shows the `assessiq` MCP as Connected. `/home/node/.claude.json` is absent. A `claude -p` smoke test returned OK.

**New operator rule for a re-login.** The containers do NOT read the host `/root/.claude.json` any more. On the host, run `CLAUDE_CONFIG_DIR=/root/.claude claude`, then `/login`. This updates the directory copy. Credentials stay in `/root/.claude/.credentials.json` (shared). You do not need to restart the containers after a re-login.

**Rejected.** Keep the file bind and add a restart step after each login: this depends on people remembering it, and it caused the stale-file incident.

**Not included.** The host `/root/.claude.json` is not deleted. It stays as a backup and for host-side use.

**Downstream impact.** The memory note "restart api+worker after /login" is obsolete. Any runbook that edits the host `/root/.claude.json` must edit `/root/.claude/.claude.json` instead.

**Rollback.** Restore `/root/docker-compose.yml.bak-20261009-rw11`, OR `git revert e8c12cf`. Then run `up -d --no-deps --force-recreate assessiq-api assessiq-worker`.
