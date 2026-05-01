# RCA / incident log

> Append-only. One entry per resolved bug or incident.
> Read at Phase 0; recurring patterns become Phase 3 critique guardrails.
> Format reference: see `CLAUDE.md` § RCA / incident log.

## 2026-05-01 — assessiq.automateedge.cloud returning 502 (Phase 0 premature DNS+Caddy wiring)

**Symptom:** Cloudflare error page on `https://assessiq.automateedge.cloud/` — "Bad gateway, Error code 502". Browser → Cloudflare path healthy, origin host marked "Error". Other apps on the shared VPS (`accessbridge`, `roadmap`, `ti-platform`, `intelwatch.in`) unaffected.

**Cause:** Caddy block in `/opt/ti-platform/caddy/Caddyfile` (lines 65–73 pre-fix) reverse-proxied `assessiq.automateedge.cloud` to `172.17.0.1:9091`, but no container was bound to host port 9091. `assessiq-frontend` was never built (no `assessiq/*` Docker images on box) and never started; only `assessiq-postgres` was running (provisioned earlier today for `02-tenancy` migration work). DNS A record (proxied) and Caddy block were both provisioned during early Phase 0 deploy plumbing, ahead of the actual `assessiq-frontend` deploy. Cloudflare reached origin Caddy successfully; Caddy got connection-refused from the missing upstream and returned 502.

**Fix:** Replaced the `reverse_proxy 172.17.0.1:9091 { ... }` directive in the AssessIQ Caddy block with a `respond 200` placeholder that serves a minimal HTML "We are building" page directly from Caddy. No new container, no new image, no new resource consumption. Block now: `header Content-Type "text/html; charset=utf-8"; header Cache-Control "no-store"; respond 200 { body "<HTML>"; close }`. Edit applied via in-place truncate-write to preserve the bind-mount inode (single-file mount `/opt/ti-platform/caddy/Caddyfile -> /etc/caddy/Caddyfile`), validated with `caddy validate`, then graceful `caddy reload`. External smoke through Cloudflare returns 200 with expected body and security headers; `cf-cache-status: DYNAMIC` confirms `no-store` honored. Caddyfile pre-edit backup at `/opt/ti-platform/caddy/Caddyfile.bak.20260430-205811` on the VPS.

**Prevention:**

1. Documentation: `docs/06-deployment.md` § "Current live state — Phase 0 placeholder" now records that the target reverse-proxy block is **aspirational** until `assessiq-frontend` ships, and pins the swap-back procedure (with the inode-preservation rule). Future sessions reading the deployment doc see the divergence between target and live state explicitly.
2. Process rule: do **not** wire DNS + Caddy for an AssessIQ subdomain ahead of the corresponding container deploy. If the public domain has to exist (e.g. for stakeholder previews), the Caddy block must use `respond` (or a static `file_server` with a placeholder) until the upstream is verified live with `curl 172.17.0.1:<port>` from the VPS. Treat "Caddy block points to unbound host port" as a Phase 3 bounce condition for any deploy diff.
3. Bind-mount inode trap: this is the second incidence of the inode-preservation gotcha on this VPS (the `CLAUDE.md` "Caddy bind-mount inode" note already flagged it). The swap-back procedure in `06-deployment.md` now spells out `cat new > Caddyfile` (truncate-write) and the `never mv` rule explicitly.

**Order-of-operations note:** the Definition-of-Done order (commit → deploy → document → handoff) was inverted for this incident — production was returning 502, so the Caddyfile fix was deployed before the documenting commit. The deploy is captured in this RCA + the deployment doc + the SESSION_STATE handoff in the same commit, so the live state is reproducible from this SHA. For non-incident work the standard order applies.

