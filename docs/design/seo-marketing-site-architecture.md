# SEO marketing site — architecture decision (Phase 0)

> **Status:** PROPOSED (draft for review, 2026-05-22). Implements **Phase 0** of [SEO_Strategy.md §17](SEO_Strategy.md) — the hard blocker that unblocks all other SEO work.
> **Scope:** *where* the public marketing/content site lives, *how* it renders, *how* it coexists with the existing app on `assessiq.in`, *how* it shares branding, and *how* it deploys additively on the shared VPS.
> **Not in scope:** the content of individual pages (that's Phase 1+). This doc decides the container/route/deploy shape only.
> **Implementation gate:** the build-out touches `infra/**` + the shared ti-platform Caddyfile = **load-bearing** (CLAUDE.md). The Caddy/compose diff must pass a `codex:rescue` adversarial sign-off before push, and follow the additive-only, inode-safe, canary-with-auto-revert procedure already documented in [06-deployment.md](../06-deployment.md).

---

## 1. Context — the two facts that force this decision

1. **The app is a pure CSR SPA.** [apps/web](../../apps/web) is Vite + React + react-router-dom. Its first response is an empty shell; bots that don't run JS see nothing, and `/` does `<Navigate to="/admin/login">` ([App.tsx:73](../../apps/web/src/App.tsx#L73)). A marketing/blog page built *inside* this SPA will not rank. (SEO_Strategy §16.1.)
2. **There is no public surface today.** Every route is gated app. We are *building* a public site, not optimizing one.

Therefore the public site must be **server-rendered or static**, and — because it has a different lifecycle, different audience, and must not bloat the app bundle — it should be a **separate project**, not a bolt-on to the SPA.

## 2. Decision 1 — rendering: **Astro (SSG)**

| Option | Verdict | Why |
|---|---|---|
| **Astro, static (SSG)** | ✅ **Chosen** | Marketing/glossary/comparison/blog are *stable* content → static-generate. Astro ships **zero JS by default** (best Core Web Vitals = a ranking factor), supports MDX for the content cluster, and can embed React "islands" if a page ever needs interactivity. Cheapest to build + maintain — matches the lean (~monthly) content bandwidth. |
| Next.js (SSR/SSG/ISR) | ❌ Not now | More capable, but its per-request SSR value isn't needed for static marketing pages, and it carries a heavier runtime + ops surface. Revisit only if pages need request-time personalization. |
| Prerender the existing SPA | ❌ Rejected | Couples marketing to the app's deploy cycle, fights the SPA's architecture, and still ships the app's JS to marketing visitors. The doc itself calls CSR-only "the highest-risk posture." |

**Consequence:** the public site is a tree of static HTML/CSS (+ minimal JS islands), buildable to a `dist/` folder and servable by any static file server.

## 3. Decision 2 — monorepo location: **`apps/marketing/`**

A new workspace package, sibling to `apps/web` (SPA) and `apps/api`:

```
apps/
  web/         # existing React SPA (the gated app)        → noindex
  api/         # existing Fastify API
  marketing/   # NEW — Astro SSG public site               → the SEO surface
```

- Own `package.json` (`@assessiq/marketing`), own `astro.config.mjs`, own build (`astro build` → `apps/marketing/dist/`).
- Joins the existing pnpm workspace; shares lint/tsconfig conventions.
- Owns `robots.txt` and the typed sitemaps as build outputs (so they're real static files, not SPA-fallback `index.html` — §6.2/§3.1 of the strategy).

## 4. Decision 3 — host coexistence: **path-split on `assessiq.in` (keep the app where it is)**

This is the load-bearing infra choice. Two viable shapes:

### Option A — path-split on the apex *(✅ recommended, do now)*

Marketing **owns the apex root and all public paths**; the app keeps its current paths; the API keeps its current paths. One host, routed by Caddy.

```
assessiq.in/                      → assessiq-marketing (Astro static)   ← default
assessiq.in/about, /pricing,
           /compare/*, /tests/*,
           /glossary/*, /resources/*,
           /robots.txt, /sitemap*  → assessiq-marketing
assessiq.in/admin/*, /candidate/*,
           /take/* (GET)           → assessiq-frontend  (existing SPA)
assessiq.in/api/*, /embed*,
           /help/*, /take/start    → assessiq-api       (existing)
```

- **Why recommended:** the `assessiq.in` migration *just* shipped (2026-05-22) — OAuth redirect, session-cookie scope, `x-origin-verify`, AOP origin cert all freshly settled. Option A is **fully additive** (one new container + extend the single existing Caddy block) and disturbs none of that. Marketing lands on the high-authority apex root, which is what we want for SEO.
- **SEO impact of the app sharing the host:** none. `/admin`, `/take`, `/candidate` are `noindex` + robots-disallowed regardless of host; the apex still accrues all marketing authority.
- **The "new-route-needs-allowlist" discipline applies** (strategy §3.9): because the app/api matchers are explicit and marketing is the default `handle`, *new app/api paths* must be added to their matcher or they'll fall through to marketing. Bake into the PR checklist.

### Option B — subdomain split *(defer; cleaner eventual state)*

Marketing on `assessiq.in`, app moves to `app.assessiq.in`. Cleaner separation, and the wildcard Origin Cert (`*.assessiq.in`) already created during the migration (06-deployment prereq #4) covers it. **But** it re-triggers the OAuth redirect URI, session-cookie scope, and `ASSESSIQ_BASE_URL` changes we just stabilized. **Not worth the churn now** — revisit if/when a clean app/marketing separation is justified.

> **Recommendation: ship Option A now, keep Option B as a documented future migration.**

## 5. Decision 4 — branding shared from `modules/17-ui-system`

The marketing site must look like the product. Reuse, don't re-invent (per [feedback-ui-template-canonical], CLAUDE.md rule #7):

- **Design tokens / Tailwind preset:** consume the same tokens that drive `@assessiq/ui-system` so colours, type, spacing match. Export a shared Tailwind preset (or the CSS variables) from the UI-system package and import it in `apps/marketing`'s Tailwind config.
- **Components:** marketing pages are mostly Astro components styled with the shared tokens. Where a genuinely interactive widget is needed (e.g. a pricing toggle, a free sample-test), use an **Astro React island** importing from `@assessiq/ui-system`.
- **Naming caveat:** the kit's internal files use the "AccessIQ" typo — **do not mass-rewrite** (CLAUDE.md rule #7); only consume. Inherit from `modules/17-ui-system/AssessIQ_UI_Template/` per [docs/10-branding-guideline.md](../10-branding-guideline.md), which is mandatory reading before building any page.

## 6. Decision 5 — deploy: new `assessiq-marketing` container, additive

Mirror the existing `assessiq-frontend` pattern exactly (it already does this for the SPA):

- **New service in [infra/docker-compose.yml](../../infra/docker-compose.yml):** `assessiq-marketing` — multi-stage Dockerfile (`node` build runs `astro build` → `nginx:alpine` serves `dist/`). Container name `assessiq-marketing` (namespaced per CLAUDE.md #8). Publish one host port, e.g. **`9093:80`** (9091 = frontend, 9092 = api are taken), reachable by ti-platform Caddy via bridge gateway `172.17.0.1:9093`.
- **Caddy:** *extend the existing assessiq.in block* — add the marketing matchers / make marketing the default `handle`, route app + api paths explicitly. Edit via the **inode-safe truncate-write + backup + `caddy validate` + `caddy reload` + canary-with-auto-revert** procedure already documented in 06-deployment §AOP and §Reverse-proxy. **Never `mv`/`sed -i`** the Caddyfile (bind-mount inode trap, RCA 2026-04-30). One block, append/extend only — no neighbor edits.
- **Deploy = the standard git-clone flow:** `ssh assessiq-vps 'cd /srv/assessiq && git pull'` → `docker compose -f infra/docker-compose.yml build assessiq-marketing` → `up -d --no-deps assessiq-marketing`. Source is baked into the image, so a code change needs a rebuild (same as `assessiq-frontend`).

### 6.1 The origin-verify / AOP interaction — a relief, not a trap

The painful `x-origin-verify` **`enforce`** behaviour lives in the **Node app middleware** ([client-ip.ts](../../modules/01-auth/src/client-ip.ts)). The marketing site is **static** — served by its own nginx container, it **never hits that middleware**, so it **cannot 429** the way `assessiq.in` did during the migration. The network-layer **AOP** (`client_auth require_and_verify` on the Caddy block) *does* apply to the whole host — but marketing traffic arrives **through Cloudflare** (orange-cloud), which presents the trusted Origin-Pull cert, so the handshake passes. **Net: marketing is unaffected by the origin-verify trap, provided it stays behind Cloudflare and is served as static (not proxied through the Node app).**

### 6.2 Cloudflare cache + robots verification

- **Cache rule (additive, CF dashboard):** "Cache Everything" for marketing paths; bypass cache for `/api/*`, `/admin/*`, `/take/*`. Free CWV win.
- **Edge-verify (strategy §3.1, proven for us by RCA 2026-05-22):** after go-live, `curl` `robots.txt`, a sitemap, and the home page with a real Googlebot UA *through Cloudflare* — confirm CF isn't intercepting/merging them.

## 7. Risks & sharp edges

- **Caddyfile is shared infra.** A bad edit can take down neighbors (`intelwatch.in`, `accessbridge.space`, `automateedge.cloud`). Use the canary-with-auto-revert 4-probe gate from 06-deployment; one block only; backup first.
- **Inode trap.** Truncate-write only (`cat >`, `printf >`). Re-confirm loaded config via the Caddy admin API after reload.
- **Route fall-through.** With marketing as the default route, any *new* app/api path must be added to its explicit matcher or it silently serves a marketing 404. PR-checklist item.
- **Soft-404s.** Astro must emit real HTTP 404s for unknown marketing paths (not a 200 shell) — configure a 404 page + ensure the static server returns 404 status. (Strategy §16.8.)
- **CHECK D lint** (06-deployment) validates email links against **SPA** routes in `App.tsx`; marketing routes live in Astro and are invisible to it. Email links should continue to target SPA/app routes (`/take/...`), so this is a note, not a conflict.

## 8. Open questions (need product-owner input before implementation)

1. **Canonical apex vs `www`** — pick one (`assessiq.in` recommended) and 301 the other. Both Caddy blocks exist today.
2. **Confirm Option A** (path-split, app stays on apex) vs. Option B (app → `app.assessiq.in`). Recommendation: A now.
3. **Confirm Astro** as the framework (vs Next) — recommendation: Astro.
4. **Static server choice** for the marketing container: `nginx:alpine` (mirror `assessiq-frontend`) vs. Caddy `file_server`. Recommendation: nginx:alpine for consistency.

## 9. Definition-of-done for Phase 0 (when implemented)

Commit → deploy → document → handoff (CLAUDE.md #9). Specifically: `apps/marketing` scaffold + a placeholder home that returns real SSG HTML; `assessiq-marketing` compose service; extended Caddy block (codex:rescue-gated); robots.txt + an empty-but-valid sitemap index served from marketing; CF cache rule; edge-verify curl pass; update [06-deployment.md](../06-deployment.md) (new container + Caddy block) and [SEO_Strategy.md §17](SEO_Strategy.md) (mark Phase 0 done).
