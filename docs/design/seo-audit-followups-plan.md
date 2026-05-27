# SEO Audit Follow-ups — saved plan (implement later)

**Status:** NOT STARTED. Saved 2026-05-27.
**Origin:** Audit of AssessIQ's SEO against the `claude-seo` skill suite (v2.0.0, installed globally to `~/.claude/skills/`). This doc captures the follow-up actions so a future session can execute without re-running the audit.

## TL;DR verdict

AssessIQ's SEO is in good shape. The architecture is correct: a **static Astro marketing site** (`apps/marketing`, fully indexable, server-rendered) split from the **auth-gated React SPA** (`apps/web`, deliberately `noindex` + robots-disallowed), with Caddy routing the public apex to marketing and `/admin /candidate /take` to the SPA. **No Critical findings.** The items below are verification gaps + polish.

## What is already covered (do NOT redo)

- robots.txt with gated-route Disallow + `Sitemap:` reference — `apps/marketing/public/robots.txt`
- Build-time `sitemap-index.xml` + `sitemap-0.xml`, absolute HTTPS URLs — `apps/marketing/astro.config.mjs`
- Full `<head>` contract (canonical, robots meta, OG w/ image:width/height + `og:locale en_IN`, Twitter card, theme-color, favicon set) — `apps/marketing/src/layouts/BaseLayout.astro`
- JSON-LD (server-rendered): Organization, WebSite+SearchAction, SoftwareApplication, Service, BreadcrumbList — only ACTIVE schema types, no deprecated (no HowTo)
- `llms.txt` present + correctly formatted — `apps/marketing/public/llms.txt`
- `BingSiteAuth.xml` (Bing Webmaster verification) present
- PWA manifest, real 404 (not 200 SPA shell, noindexed), gzip/zstd, immutable hashed-asset caching, font preconnect
- E-E-A-T author/date/Article signals on content pages (105 matches / 23 files)
- No fabricated aggregateRating (honest — keep it that way until real reviews exist)
- Images category is N/A today (zero `<img>`; text + inline SVG only)

## Action items (priority = claude-seo skill scheme)

### HIGH — verify within 1 week

1. **Confirm security headers are actually served on `assessiq.in`.**
   - **Why:** Technical SEO weights Security at part of its 22%. `apps/caddyfile/assessiq.snippet:104` does `import security-headers`, but that snippet lives in the **shared VPS Caddyfile** (`/opt/ti-platform/caddy/Caddyfile`), NOT in this repo — so it is unverifiable from code. It may already be correct; it is simply unconfirmed.
   - **How:** `curl -sI https://assessiq.in/ | grep -iE 'strict-transport|content-security|x-content-type|x-frame|referrer-policy'`. Expect HSTS, CSP, X-Content-Type-Options: nosniff, Referrer-Policy at minimum. (Read-only check; touching the shared Caddyfile is a load-bearing/infra change — additive-only, enumerate-first, per CLAUDE.md rule #8.)
   - **NOT included:** editing the shared `security-headers` snippet. Only do that if the curl shows headers missing, and gate it as infra change.

### MEDIUM — within 1 month

2. **Measure live Core Web Vitals (LCP/INP/CLS).**
   - **Why:** Performance (CWV) = 10% of health score; never measured (Playwright/PSI scripts didn't install on Windows — `bin/pip` vs `Scripts/pip`).
   - **How:** PageSpeed Insights / CrUX on top marketing pages. Watch the external Google Fonts `@import` in `BaseLayout.astro` as a render-blocking/LCP risk (already uses `&display=swap`; consider self-hosting fonts if LCP suffers).

3. **Ensure every content page emits both `datePublished` and `dateModified`.**
   - **Why:** Freshness signal for E-E-A-T (23%) and GEO authority. Present on some pages; not exhaustively confirmed.
   - **Where:** `apps/marketing/src/pages/resources/*`, `glossary/*`, `compare/*`, `methodology.astro`.

### LOW / INFO — backlog

4. **FAQPage rich-results reality (info only, no action required).** Test pages use FAQPage schema. Google restricted FAQ rich results to gov/health since Aug 2023 → these will NOT render as Google rich snippets, but they retain AI/LLM citation value. Keep them; just don't expect SERP FAQ accordions. Do NOT add new FAQPage for Google benefit.
5. **IndexNow** for faster Bing/Yandex indexing (Bing verification already present). Optional.
6. **Sitemap `lastmod` is hardcoded to build date** (all-identical) — wire real per-page modification dates when practical. `apps/marketing/astro.config.mjs`.
7. **Future raster/blog images** must ship with `alt`, explicit width/height (CLS), and webp/avif. N/A until images are added.

## Explicitly NOT in scope

- The gated SPA (`apps/web`) — correctly excluded from indexing; no per-page meta / SSR needed there.
- hreflang / i18n — single-language (en-IN) by design.
- RSL 1.0 licensing — emerging standard, skip for now.
- Re-architecting anything — the marketing/SPA split is correct and stays.

## Downstream impact

- Item 1 may touch shared VPS infra (Caddyfile) — load-bearing, additive-only, enumerate-first.
- Items 2–3 are marketing-site-only (`apps/marketing`), non-load-bearing; standard Sonnet-implement + Opus-review.
- Doc updates on execution: `docs/06-deployment.md` (if headers/infra), module SKILL or `docs/08-ui-system.md` if marketing templates change.
