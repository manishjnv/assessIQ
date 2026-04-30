# Session — 2026-04-30

**Headline:** Phase 0 prerequisites complete — TLS reachable end-to-end via Caddy + Cloudflare, all 7 plan decisions captured, three execution prompts ready for parallel Windows 1-3.

**Commits:**

- `887a906` — docs: pivot Phase 0 deploy to Caddy + Cloudflare; capture decisions
- `e6fed9a` — docs: add Definition-of-Done hard rule (#9) to project CLAUDE.md

**Tests:** skipped — planning + infra session; no code shipped this session.

**Next:** Open Window 1 (G0.A — repo bootstrap + `00-core`) using the prompt prepared in chat. Once its commit lands on `origin/main`, fire Windows 2 (02-tenancy) and 3 (17-ui-system) in parallel.

**Open questions:**

- Append the cert paste-with-tab gotcha (leading-tab + CRLF strip via `sed`) as a one-liner under `docs/06-deployment.md` § cert procurement? Offered, awaiting confirmation.
- DMARC record recommended by Cloudflare for `automateedge.cloud` — out of scope for AssessIQ; flag if email deliverability becomes an issue.
- Sentry DSN, SMTP provider — placeholders in `.env`, deferred to Phase 3 per plan.

---

## Agent utilization

- **Opus:** orchestrator throughout — authored the phase-list table + parallel-session grouping, the Phase 0 kickoff plan synthesis, the `docs/06-deployment.md` rewrite, the Caddyfile block design, all final tool calls (SCP, cert verify, Caddy validate/reload, TLS probe), the three Window prompts, and this handoff.
- **Sonnet:** n/a — no implementation work this session. First Sonnet delegation lands in Window 1 for the `00-core` module scaffold.
- **Haiku:** 6 read-only Explore agents in 2 parallel bursts. Burst 1 (4 agents) discovered the Phase 0 module contracts: 00-core+02-tenancy+03-users specs, 01-auth + auth flows, 17-ui-system + branding template, scaffold + deploy audit. Burst 2 (2 agents) enumerated the shared VPS — first general inventory (apps + paths + ports + Postgres/Redis status), second drilling Caddy specifically (mount paths, Caddyfile structure, port survey for clash-free upstream).
- **codex:rescue:** n/a — no security/auth/classifier code touched. First invocation gates Window 2 (02-tenancy RLS) before its push.

---

## Decisions captured (all 7 plan open-questions resolved)

1. **Google OAuth client provisioned.** Credentials placed in repo-root `.env.local` (gitignored via `.env.*` rule). Redirect URI `https://assessiq.automateedge.cloud/api/auth/google/cb`. Specific values never seen by Claude — local-only.
2. **VPS path = `/srv/assessiq/`.** Matches the `/srv/roadmap/` precedent on the box. `docs/06-deployment.md` rewritten to align (was `/opt/assessiq` in the stale draft).
3. **Recovery codes:** 8-char Crockford base32 (excludes I/L/O/U), 10 codes/user, argon2id `m=65536, t=3, p=4`. Single-use.
4. **Tailwind kept.** `--aiq-*` CSS tokens are source of truth for color/typography; Tailwind theme reads from them; utilities accelerate layout/spacing.
5. **Redis session key:** `aiq:sess:<sha256(token)>` → JSON `{userId, tenantId, totpVerified, expiresAt, createdAt, ip, ua}`, EXPIRE 8h, sliding refresh on each authenticated request.
6. **Rate limits:** 10/min/IP on `/api/auth/*`, 60/min/user, 600/min/tenant aggregate. Token bucket in Redis. Client IP extracted from Caddy-normalized request (CF-Connecting-IP via Caddy's existing `trusted_proxies`), NOT raw `X-Forwarded-For`.
7. **Dedicated `assessiq-postgres` + `assessiq-redis` containers.** Not shared with ti-platform's TimescaleDB (which has hardcoded `ti`/`ti_secret` creds). Daily logical dump to `/var/backups/assessiq/`.

---

## Deploy reality — pivot recorded

The original draft assumed nginx + Let's Encrypt + certbot in our Compose stack. Read-only VPS scan (2 Haiku agents) revealed:

- **Caddy already owns 80/443** (container `ti-platform-caddy-1`). Caddyfile at `/opt/ti-platform/caddy/Caddyfile` already lists Cloudflare IPs in `trusted_proxies` and uses bridge-gateway upstreams (`172.17.0.1:<port>`) to reach roadmap and accessbridge across Docker networks.
- **Cloudflare orange-cloud fronts** `automateedge.cloud`. HTTP-01 would fail through CF; DNS-01 would need a Caddy image rebuild.
- **Three other apps share the box:** `ti-platform` (Next.js + FastAPI + TimescaleDB + OpenSearch + Redis + Caddy itself), `accessbridge-*` (ports 8080/8100/8200/8300/9090), `roadmap-*` (port 8090). Resource headroom comfortable: 4.3 GB available, AssessIQ adds ~1 GB.

**Resolved deploy plan:**

- AssessIQ on its own `assessiq-net` Docker network at `/srv/assessiq/`. Only `assessiq-frontend` publishes a host port: **9091** (chosen because nothing on the box uses 90xx).
- One additive server block appended to ti-platform's Caddyfile, upstream `172.17.0.1:9091` — matches the established roadmap/accessbridge pattern. **Zero edits to ti-platform's `docker-compose.yml`** (rejected the alternative `extra_hosts` option that would have touched ti-platform's compose).
- Origin TLS via **Cloudflare Origin Certificate** (RSA 2048, wildcard `*.automateedge.cloud`, 15-year, valid → 2041-04-26), placed at `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}` with perms `0644`/`0600`, root-owned. CF zone SSL/TLS mode = **Full (Strict)** (user upgraded mid-session).

---

## Infrastructure brought up this session

| Step | Outcome |
| --- | --- |
| Cloudflare DNS A record `assessiq` → `72.61.227.64` (Proxied) | ✅ Verified via PowerShell `Resolve-DnsName` — returns CF anycast IPs `172.67.151.188`, `104.21.1.12` |
| CF Origin Cert generated (user) | ✅ Wildcard `*.automateedge.cloud`, RSA 2048, expiry 2041-04-26 |
| Cert + key SCP'd to VPS, perms set | ✅ Matching accessbridge precedent (`0644`/`0600`, root) |
| Cert/key paste artifact fixed | ✅ `sed -i 's/\r$//; s/^[[:space:]]*//'` on both files (CF dashboard pastes with leading tabs + CRLF; OpenSSL refuses to parse). Local copies cleaned too. |
| Cert/key match | ✅ Modulus md5 verified |
| Caddyfile backup | ✅ `/opt/ti-platform/caddy/Caddyfile.bak.20260430-182219` |
| AssessIQ server block appended | ✅ 8 lines, modeled on the accessbridge precedent (static `tls`, `import security-headers`, `reverse_proxy 172.17.0.1:9091`, `encode zstd gzip`) |
| `caddy validate` | ✅ "Valid configuration" (one non-blocking format warning at line 38) |
| `caddy reload` (graceful) | ✅ All 13 sibling containers preserved (uptime unchanged) |
| Public TLS probe | ✅ `curl https://assessiq.automateedge.cloud/` → `502 Bad Gateway` from Caddy via CF Mumbai POP (`cf-ray: 9f489308da097ea4-MAA`). 502 is correct intermediate — TLS handshake works end-to-end; 502 will turn to real responses the moment Window 1's bootstrap deploys the AssessIQ stack on port 9091. |
| CF zone SSL/TLS = Full (Strict) | ✅ User toggled mid-session |
| Memory updated | ✅ `vps-shared-host.md` now records Caddy reality, port 9091, the 3 coexisting apps, additive Caddyfile-edit exception, and CF Origin Cert path |

---

## Sharp edges for next session

1. **Cert paste-with-tab gotcha.** When pasting a CF Origin Cert (or any PEM) from the CF dashboard, every line gets a leading tab + CRLF. OpenSSL fails to parse silently with "Could not read certificate". Fix in place: `sed -i 's/\r$//; s/^[[:space:]]*//' file.pem file.key`. Worth pinning into `docs/06-deployment.md` if confirmed.
2. **Caddyfile format warning at line 38** is non-blocking (`caddy fmt --overwrite` would fix). Do **not** run `caddy fmt` in any future session — it would rewrite the entire ti-platform-owned Caddyfile, violating CLAUDE.md rule #8 additive-only constraint.
3. **`assessiq-frontend` not running yet.** `https://assessiq.automateedge.cloud/` returns 502 until Window 1 (G0.A) deploys the stack. This is the success state for the bootstrap, not a bug.
4. **Three windows are sequential-then-parallel, not all-three-parallel.** Window 1 (G0.A) must merge to `main` before Windows 2 and 3 start — both depend on the repo scaffold + `00-core` module that Window 1 produces. The Window 2 and Window 3 prompts both include a `git pull` gate that stops if the bootstrap commit is not present.

---

## Phase 0 execution prompts ready

Three self-contained prompts prepared in this session's chat for parallel-window execution:

- **Window 1 (G0.A):** repo bootstrap + `00-core` module. Blocker for the rest of Phase 0.
- **Window 2 (G0.B Session 2):** `02-tenancy` — migrations, RLS policies, middleware, BYPASSRLS role. **Load-bearing**, requires `codex:rescue` adversarial pass before push (CLAUDE.md rule #4 + load-bearing-paths). First real VPS deploy lands here.
- **Window 3 (G0.B Session 3):** `17-ui-system` — Vite + React 18 + Tailwind SPA scaffold; component port from `AccessIQ_UI_Template/` (Button, Card, Input, Chip, Icon, Logo, Num); Storybook; ThemeProvider stub.

Each prompt mandates the Phase 0 reading list, gates on prior commits where appropriate, names anti-patterns to refuse, and ends with the four-step DoD requirement (commit → deploy → document → handoff).
