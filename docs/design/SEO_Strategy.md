# SEO Playbook — Candidate / Team Assessment Platform

> **Reusable, stack-agnostic SEO strategy** distilled from a production SEO implementation (27 sequenced tasks, shipped + measured) and re-mapped to a candidate-assessment domain. Contains **only SEO methodology** — none of the source product's business logic.
>
> **Domain assumed:** a SaaS platform that lets IT companies and educational institutions assess candidates / teams (skills tests, coding tests, aptitude, proctored exams, team skill-gap analysis, certification). Think the competitive set of HackerRank / TestGorilla / Mettl / iMocha / Codility / Vervoe.
>
> **Rendering assumed:** SSR/SSG framework (Next.js / Nuxt / Astro). Where the source repo solved a client-side-render problem with a server scaffold, this plan instead assumes server rendering is available — but §3.4 keeps the decision-tree so the plan survives a stack change.
>
> **How to read this:** §0–§4 are the always-on technical foundation (ship first, in order). §5 is the programmatic growth engine. §6–§9 are content/authority/GEO/international. §10 is an optional module. §11–§13 are ops + guardrails. §14 is the actionable, sequenced backlog (`ASMT-00…ASMT-30`). §15 is copy-paste schema.

---

## 0. The one rule, and how to use this playbook

**Instrument before you invest.** No SEO work precedes measurement — otherwise you cannot tell what worked. Connect Google Search Console (GSC) + Bing Webmaster Tools, submit the sitemap index, and record a 7-day baseline (impressions, clicks, avg position, indexed URLs) **before** shipping anything else. This is `ASMT-00` and it blocks everything.

**Priorities** used throughout:

- **P0** — biggest ranking lift or unblocks other work. Target: week 1–2.
- **P1** — CTR / rich-result / Core-Web-Vitals improvements. Target: week 3–6.
- **P2** — polish & infra. Opportunistic.
- **Content / Ops** — ongoing, starts once P0 lands.

**Three principles that override any outside "best practice":**

1. **Content in the initial HTML, always.** Bing and every social/LLM preview bot render little-to-no JavaScript. Googlebot renders JS but ranks server-delivered content far more reliably. With an SSR/SSG stack this is free — *use it for every public page* and never let a marketing/library/comparison page depend on client-side hydration for its primary content.
2. **Never let structured data lie.** Every `application/ld+json` block must reflect content actually visible on the page, contain no PII, and validate clean. A malformed or deceptive block silently disqualifies the page from rich results — or earns a manual action.
3. **Reversibility.** Every schema/meta/redirect change must be revertible in one step without data loss.

---

## 1. URL architecture — the public SEO surface map

Design the URL tree once, up front. Slugs are forever; query strings are not indexable equity. Every public route below is SSR/SSG, has a self-canonical, sits in a sitemap, and carries the right schema.

```
/                                  Home (Organization + WebSite + SoftwareApplication)
/product/...                       Feature pages (proctoring, anti-cheat, code-eval, analytics, reporting)
/solutions/it-hiring               Audience hub: IT companies (technical screening)
/solutions/campus-recruitment      Audience hub: bulk / fresher hiring
/solutions/educational-institutions Audience hub: institutes (proctored exams, skill certification)
/solutions/team-skill-gap          Use-case hub: upskilling / internal mobility
/solutions/remote-interview        Use-case hub
/tests/                            ── PROGRAMMATIC ENGINE (the growth core) ──
/tests/{skill}                       per-skill: /tests/python, /tests/sql, /tests/react, /tests/aptitude
/tests/role/{role}                   per-role: /tests/role/frontend-developer, /tests/role/data-analyst
/tests/topic/{topic}                 topic clusters / hubs (ItemList of related skill tests)
/integrations/                     Integrations directory hub
/integrations/{partner}              /integrations/greenhouse, /integrations/workday, /integrations/moodle
/compare/{a}-vs-{b}                Comparison pages (vs competitors, vs methods)
/alternatives/{competitor}         "Best {competitor} alternatives" pages
/glossary/                         Glossary hub (DefinedTermSet)
/glossary/{term}                     /glossary/adverse-impact, /glossary/criterion-validity
/tools/{tool}                      Free lead-magnet tools (free coding test, sample questions, % calculators)
/resources/  (or /blog/)           Editorial hub (pillar clusters + paginated feed + search)
/resources/{slug}                    Pillar & supporting posts (Article/BlogPosting + HowTo + FAQ)
/customers/  /case-studies/{slug}  Proof (Review + AggregateRating source)
/pricing                           Bottom-funnel (Offer schema)
/about  /security  /trust          E-E-A-T + methodology + compliance (SOC2/GDPR/ISO)
─────────── gated / non-indexed ───────────
/app/**  /dashboard/**  /admin/**  /api/**   noindex + Disallow (the product itself)
/og/**                             dynamic share-image renderer (Disallow; surfaced via meta/sitemap only)
─────────── optional public candidate surfaces (see §10) ───────────
/verify/{credential_id}            shareable result / certificate verification
/badge/{id}.svg  /result/{token}   share assets
```

**Rules baked into this tree:**

- **Slug-based, lowercase, hyphenated, ASCII.** No query strings in indexed paths. Pagination uses `?page=N` (a deliberate, canonicalized exception — see §3.3).
- **One canonical URL per piece of content.** No `/tests/python/` *and* `/tests/python` *and* `/tests/Python`. Pick trailing-slash policy once and 301 the rest.
- **The gated app is not SEO surface.** `/app`, `/dashboard`, `/admin`, `/api` are `noindex` + robots-disallowed. They have zero ranking value and leaking them risks indexing private data.

---

## 2. Phase 0 — Instrumentation & foundations (P0, do first)

`ASMT-00` — **Connect consoles + baseline.**

1. Verify the domain in **Google Search Console** (DNS TXT record preferred — survives deploys and covers all subdomains) and **Bing Webmaster Tools**.
2. Submit `https://{domain}/sitemap_index.xml` in both.
3. Install privacy-respecting analytics (GA4 or Plausible/Umami) + GSC API export. Wire a weekly impressions/clicks pull.
4. Record a 7-day baseline (indexed URLs, impressions, clicks, avg position, Core Web Vitals field data) in a change log.
5. **Verification tokens / API keys live in env vars, never in the repo.**

**Acceptance:** both consoles show "ownership verified," sitemap submission "Success," baseline recorded.

---

## 3. Technical SEO foundation (always-on layer)

### 3.1 Crawl control — `robots.txt`, `llms.txt`, edge caveat

**`robots.txt`** (served at the edge or origin, `Content-Type: text/plain`, ~1-day cache):

```text
User-agent: *
Disallow: /app
Disallow: /dashboard
Disallow: /admin
Disallow: /api
Disallow: /og/
Disallow: /*?*sort=
Disallow: /*?*filter=
Allow: /

Sitemap: https://{domain}/sitemap_index.xml
```

- Disallow the gated app, the OG renderer (images are surfaced via `og:image` + sitemap, never crawled as standalone URLs), and **faceted-filter query params** that would otherwise spawn infinite low-value crawl paths (§3.4).
- **Always include an explicit `Sitemap:` directive** — primes engines that don't auto-probe `/sitemap.xml`.

**Critical operational caveat (learned the hard way):** if you front the site with a CDN (Cloudflare, etc.), the **edge may intercept or merge `/robots.txt`** with its own managed content. **Always verify the live file with an external `curl` using a real crawler UA — never assume your origin config is what crawlers see:**

```bash
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" https://{domain}/robots.txt
```

If the edge serves a different file, fix it in the CDN dashboard, not just at origin. (A useful side effect: many CDNs now inject AI-crawler controls like `Content-Signal: search=yes, ai-train=no` and per-bot `Disallow` rules — keep those; they let you appear in AI search while opting out of model training.)

**`llms.txt`** (net-new, 2026) — publish `https://{domain}/llms.txt`, a Markdown map of your highest-value pages for LLM/answer-engine crawlers (a proposed convention adopted by a growing set of docs/SaaS sites). It complements, not replaces, the sitemap. Keep it to your money pages: top solution pages, the test-library hub, pricing, glossary, key guides.

### 3.2 Sitemaps — index + typed children + image extensions

Split by resource type so GSC's per-sitemap indexation report tells you *which* content class has a crawl problem. A single mega-sitemap hides that signal.

```
/sitemap_index.xml          (master index, 1h cache)
├── /sitemap-pages.xml        marketing/solutions/product/pricing/about
├── /sitemap-tests.xml        every /tests/{skill}, /tests/role/{role}, /tests/topic/{topic}
├── /sitemap-integrations.xml every /integrations/{partner}
├── /sitemap-compare.xml      /compare/* + /alternatives/*
├── /sitemap-glossary.xml     every /glossary/{term}
├── /sitemap-resources.xml    blog/resource posts + topic hubs
├── /sitemap-customers.xml    case studies
└── /sitemap-verify.xml       (optional, §10) public credential pages where shareable=true
```

Per-URL pattern — **`<lastmod>` on every URL** (a quality signal many sites skip), and the **image namespace** on entries that have a dynamic OG image:

```xml
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://{domain}/tests/python</loc>
    <lastmod>2026-05-22</lastmod>
    <image:image><image:loc>https://{domain}/og/test/python.png</image:loc></image:image>
  </url>
</urlset>
```

- Keep each child < 50k URLs / < 50MB uncompressed; split further if the test library outgrows that.
- Generate dynamically from the DB/CMS so new pages auto-enter the sitemap. Cache children 1h, index 1h.
- Skip `<priority>`/`<changefreq>` agonizing — Google largely ignores them. `<lastmod>` is the field that matters; keep it honest (it must reflect a real content change, or Google learns to distrust it).

### 3.3 Canonicalization & URL hygiene

- **Self-referencing `<link rel="canonical">` (absolute URL) on every indexable page.** Missing canonicals are the most common avoidable indexation bug.
- **Pagination:** `/resources?page=2` is **self-canonical** to `/resources?page=2` (NOT to page 1 — that drops deep pages from the index). Add `rel="prev"`/`rel="next"` link hints. Render pagination **server-side**; infinite scroll may layer on top as progressive enhancement, but numbered SSR pages are the crawl path.
- **Faceted / filtered library pages** (`/tests?skill=python&level=hard&sort=...`): canonicalize back to the clean hub, `noindex` the filtered combinations, and disallow the param patterns in robots. This is the #1 index-bloat trap for catalog sites — thousands of thin filter permutations dilute crawl budget and trip "scaled content" signals.
- **One host, one protocol.** 301 `http→https` and `www↔non-www` to the single canonical host. Enforce trailing-slash policy with a single redirect rule. Do this at the edge/server, not in app code.
- **Never 302 a permanent move** (302 doesn't pass equity the way 301 does). Audit redirect chains — collapse `A→B→C` to `A→C`.

### 3.4 Rendering & indexability (the make-or-break for SaaS)

With an SSR/SSG framework, **render every public page's primary content server-side.** Concretely:

- **Marketing, solutions, library, comparison, glossary, blog → SSG or SSR.** Static-generate what's stable (glossary, comparison), server-render or ISR what's data-driven (test library counts, pricing).
- **The app (`/app`, `/dashboard`) → CSR + `noindex`.** It has no SEO value; keep it out of the index entirely.
- **Hydration must not change indexable content.** If JS rewrites the H1/copy after load, Google may rank the pre-hydration version. Keep server and client output consistent.

**Decision-tree if the stack ever changes** (so this plan survives):

| Stack reality | SEO action |
|---|---|
| SSR/SSG framework (assumed) | Render public pages server-side. Done. |
| Client-side SPA (CSR-only) | **Highest-risk posture.** Add SSR/prerendering for public routes, or ship a server-rendered **content scaffold** in the initial HTML (real H1/H2/copy/links) that the SPA replaces on mount. Never ship an empty `<div id="root">` for a page you want to rank. |
| Traditional server-rendered | Already fine; focus on schema + speed. |

**Indexability hygiene:** `noindex` only what you can't fix (gated app, thank-you pages, internal search results, filter permutations). Never `noindex` a page you could simply improve. Keep an `X-Robots-Tag`/meta-robots audit in the monthly review.

### 3.5 The `<head>` contract (every public page)

A shared head component takes per-page values and emits exactly this set. Escape every injected value (framework auto-escaping or a JSON-safe serializer — a stray quote or `</script>` in a title can break a JSON-LD block or inject markup).

```html
<title>{Specific Page Title} — {Brand}</title>           <!-- ≤ 60 chars, primary keyword front-loaded -->
<meta name="description" content="{compelling 150–160 char summary with the query intent}">
<link rel="canonical" href="{absolute self URL}">
<meta name="robots" content="index,follow">              <!-- or noindex on gated/thin pages -->

<!-- Open Graph -->
<meta property="og:type" content="website">              <!-- "article" on posts -->
<meta property="og:title" content="{= title, sans brand suffix is fine}">
<meta property="og:description" content="{= description}">
<meta property="og:url" content="{absolute self URL}">
<meta property="og:site_name" content="{Brand}">
<meta property="og:image" content="https://{domain}/og/{type}/{slug}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{= og:title}">
<meta name="twitter:description" content="{= og:description}">
<meta name="twitter:image" content="{= og:image}">

<!-- Discovery -->
<link rel="alternate" type="application/rss+xml" title="{Brand} Resources" href="/resources/feed.xml">
<meta name="theme-color" content="#0b1220">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

- Title and description are **CTR levers** — write them for humans + intent, not keyword stuffing. Unique per page; never templated to the point of duplication.
- `og:image` points at the dynamic renderer (§3.7).

### 3.6 Structured data (JSON-LD) — the schema stack

Use **separate `<script type="application/ld+json">` blocks** per type (not one `@graph`) — easier to validate and debug. Map each schema to the surface that earns the rich result. Validate every block in [Rich Results Test](https://search.google.com/test/rich-results) + [Schema Markup Validator](https://validator.schema.org/) before shipping.

| Schema type | Where it goes | Rich-result / value |
|---|---|---|
| **Organization** | Sitewide (home or layout) | Knowledge-panel eligibility; `logo`, `sameAs` (LinkedIn/X/G2/Crunchbase), `contactPoint` |
| **WebSite + SearchAction** | Home | Sitelinks search box in branded SERPs (requires a *working* `/search?q=` page, not just an API) |
| **SoftwareApplication** | Home / product pages | App rich result; `applicationCategory: "BusinessApplication"`, `offers`, `aggregateRating` (only when real) |
| **Service** | Solution pages | Describes the assessment service per use case; `areaServed`, `provider` |
| **Offer / AggregateOffer** | Pricing | Price visibility (use `Offer` carefully; only if prices are public) |
| **BreadcrumbList** | Every page with a visible breadcrumb | Breadcrumb SERP display; **last (current) item has no `item` URL** |
| **FAQPage** | Solution, feature, library, comparison, glossary pages | PAA capture. Mirror a **visible** FAQ section; 6–15 Q&As drawn verbatim from People-Also-Ask |
| **Article / BlogPosting** | Every resource/blog post | `headline`, `datePublished`, `dateModified`, `author` (Person w/ real bio), `publisher` |
| **HowTo** | Step-based guides | Step rich result; emit only when the page genuinely has ordered steps |
| **ItemList** | Library hub, role catalog, integrations directory, topic hubs | Carousel eligibility + internal-link signal; `position` + `url` + `name` per item |
| **DefinedTerm + DefinedTermSet** | Glossary | Entity/definition signal for psychometrics terms |
| **Course** | Certification-prep / training content | "Course" rich result; `provider`, `hasCourseInstance.courseWorkload` (ISO-8601, **required** since 2024) |
| **Quiz** *(careful)* | Free practice-test tools | Google's education "Practice problems" result — eligibility is limited/region-gated; ship the visible quiz regardless, add schema as upside |
| **Review + AggregateRating** | Product/home, case studies | Star snippets — the single biggest CTR lever — **only from genuine, verifiable reviews** (G2/Capterra). Never fabricate; Google penalizes fake review schema |
| **VideoObject** | Pages embedding product-demo / tutorial video | Video rich result + Video tab; `thumbnailUrl`, `uploadDate`, ISO-8601 `duration`, `contentUrl`, `embedUrl` |
| **EducationalOccupationalCredential** | (Optional §10) public result/certificate pages | Credential rich result for shared candidate certificates |

Copy-paste templates for the highest-value types are in **§15**.

### 3.7 Dynamic Open-Graph image generation

Per-page share images drive social/LinkedIn/Slack/iMessage previews — a major share-and-backlink surface for B2B.

- **Route:** `GET /og/{type}/{slug}.png` → 1200×630 PNG composed at request time (Pillow/`@vercel/og`/Satori/Playwright-screenshot), branded template per type (`test`, `role`, `compare`, `resource`, `integration`, `verify`).
- **Cache to disk/CDN** keyed by `{type}/{slug}`; first request renders, rest serve cached. Bust on content update.
- **Slug-validate** with a strict regex (`^[a-z0-9][a-z0-9-]{0,120}$`) so the route can't be abused to render arbitrary text — return 404 on mismatch.
- **`Disallow: /og/`** in robots; the images reach Google via `og:image` meta + the `<image:image>` sitemap extension, not as crawlable URLs.

### 3.8 Internal linking & breadcrumbs

- **Visible breadcrumb trail** on every deep page (`Home › Tests › Python`) **backed by `BreadcrumbList` JSON-LD** (current page has no `item` URL).
- **Hub-and-spoke linking:** every `/tests/{skill}` links to its topic hub and 4–6 sibling skills; every blog post links to its pillar hub + related posts; comparison pages link to the relevant solution + library pages. Aim for a dense, intentional internal graph — it spreads authority and improves discovery.
- **Related-content blocks** on detail pages (prev/next + 3 related). Curate by topic, not just chronology.
- **Footer + top-nav** carry the canonical hubs (solutions, test library, integrations, pricing, resources) on every page — site-wide internal links to your money pages.

### 3.9 Edge / web-server config (cache, compression, security, allowlist)

```nginx
# Compression
gzip on;
gzip_types text/html text/css application/javascript application/json image/svg+xml application/xml;
gzip_min_length 1024;
# brotli on; brotli_comp_level 4;   # if the build supports ngx_brotli (or let the CDN do it)

# Cache policy
location ~* \.(?:js|css|woff2|png|jpg|svg|webp|avif)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";   # fingerprinted assets
}
location = / { add_header Cache-Control "no-cache, must-revalidate"; }   # HTML always fresh

# Serve robots/sitemaps; proxy dynamic ones to the app
location = /robots.txt { add_header Content-Type "text/plain; charset=utf-8"; }

# Slug allowlist — reject junk paths so they 404 fast instead of polluting crawl/logs
location ~ "^/tests/[a-z0-9][a-z0-9-]{0,60}$"            { try_files $uri @app; }
location ~ "^/og/(test|role|compare|resource|integration)/[a-z0-9][a-z0-9-]{0,120}\.png$" { try_files $uri @app; }

# Security headers (also a mild trust signal; required for the trust/security positioning)
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; ..." always;
```

**`new-route-needs-allowlist` rule:** if the edge uses a deny-by-default allowlist, **adding any new public route requires updating the edge config in the same change** — otherwise the route 404s in production while working locally. Bake this into your PR checklist.

### 3.10 IndexNow (instant crawl notification)

- Generate a 32-char hex key (`openssl rand -hex 16`), set it in env, serve it at `/{key}.txt`.
- On **publish/update of any indexable page** (new test page, blog post, case study, integration), fire-and-forget POST to `https://api.indexnow.org/indexnow` with `{ host, key, keyLocation, urlList }` (≤ 10k URLs/request). Never block the publish on it.
- Near-instant for Bing/Yandex; Google ingests the signal. Pair with manual GSC "URL inspection → Request indexing" for your most important new pages (throttled ~10/day — don't spam it).

---

## 4. Core Web Vitals & performance (2026 thresholds)

Performance is a ranking factor *and* a conversion factor. Targets (mobile, field data in GSC/CrUX):

| Metric | Good | Notes |
|---|---|---|
| **LCP** (Largest Contentful Paint) | < 2.5s | Server-render the hero; preload the LCP image/font; avoid render-blocking CSS/JS |
| **INP** (Interaction to Next Paint) | < 200ms | **Replaced FID in 2024.** Critical for interactive free-tool/quiz widgets — break up long tasks, defer non-critical JS, debounce handlers |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Reserve space for images/ads/embeds; `width`/`height` on all media |

Tactics:

- **Fonts:** `font-display: swap`, `preconnect` to the font host, self-host or subset where possible.
- **Images:** WebP/AVIF, responsive `srcset`, `loading="lazy"` below the fold, `fetchpriority="high"` on the LCP image.
- **CSS:** inline critical above-the-fold CSS, defer the rest. (Only invest here if Lighthouse shows LCP > 2.5s — don't pre-optimize.)
- **JS:** code-split; the quiz/code-editor widget loads only on `/tools/*`, never on the homepage. Third-party scripts (chat, analytics) loaded `async`/`defer` or via a tag manager with consent gating.
- **Edge caching/CDN** for all static + SSG output.

Measure with [PageSpeed Insights](https://pagespeed.web.dev/) and the GSC Core Web Vitals report; review quarterly, fix regressions.

---

## 5. Programmatic SEO at scale — the growth engine (with anti-spam governance)

This is where an assessment platform wins: there is **massive long-tail demand** for `{skill} test`, `{role} assessment`, `{competitor} alternative`, `{tool} integration`, and `{psychometric term}` queries. The pattern is **one template + one data source → N pages.** But it is also where sites get penalized — Google's 2024 **"scaled content abuse"** spam policy explicitly targets mass-produced thin pages. **The quality gate (§5.6) is mandatory, not optional.**

### 5.1 Skill-test library pages — `/tests/{skill}`

One template, one row of data per skill. Each page must be **genuinely useful and differentiated**, not a spun template:

- `<h1>{Skill} Online Test for Hiring & Assessment</h1>`
- 40–60 word definitional intro answering "what does a {skill} test measure?" (featured-snippet target)
- **What the test covers** — real topic breakdown (e.g. Python: data structures, OOP, comprehensions, libraries) — *unique per skill*
- **Sample questions** (2–3 real examples) — the differentiator competitors skip
- **Who should take it / which roles** — internal links to `/tests/role/*`
- **Difficulty levels, duration, format**
- Comparison to adjacent tests (link to siblings)
- FAQ (6–10, from PAA: "how long is a {skill} test", "is {skill} test free", "what score is good")
- **Schema:** `Service` or `SoftwareApplication`-subpage + `FAQPage` + `BreadcrumbList` + `ItemList` (topics covered)

### 5.2 Role-based assessment pages — `/tests/role/{role}`

Targets `{role} assessment test`, `how to assess a {role}`. Each maps a role to its skill battery:

- Role definition + responsibilities, the **competency matrix** for that role, recommended test battery (links to `/tests/{skill}`), benchmark/percentile guidance, sample scorecard, FAQ.
- `Article` + `ItemList` (of constituent skill tests) + `FAQPage` + `BreadcrumbList`.

### 5.3 Comparison & alternatives pages — `/compare/{a}-vs-{b}`, `/alternatives/{competitor}`

The **highest-intent, highest-converting** programmatic cluster (bottom-funnel buyers comparing vendors).

- `<h1>{A} vs {B}: Complete 2026 Comparison</h1>` + 50-word TL;DR (snippet target)
- Honest side-by-side table (8–12 rows: pricing model, question library size, proctoring, anti-cheat, integrations, code eval, support, free trial, ideal customer)
- A balanced "which should you choose?" section (don't trash competitors — Google and buyers both reward fairness)
- FAQ from PAA + `DefinedTerm` for each product/method
- **Schema:** `Article` + `FAQPage` + `BreadcrumbList` (+ a semantic `Table`)
- Mirror for `/alternatives/{competitor}` ("Best {competitor} alternatives in 2026") — `ItemList` of alternatives with honest pros/cons.

### 5.4 Integrations directory — `/integrations/{partner}`

Targets `{platform} assessment integration` (e.g. `greenhouse coding test integration`). Each partner page: what the integration does, setup steps (`HowTo`), screenshots, supported workflows, link to docs. `SoftwareApplication`/`Service` + `HowTo` + `BreadcrumbList`. Bonus: many partners link back from *their* marketplace — a free authority loop.

### 5.5 Glossary — `/glossary/{term}`

Own the psychometrics/assessment vocabulary (`adverse impact`, `criterion validity`, `item response theory`, `percentile rank`, `stanine`, `reliability coefficient`). Each: clear definition, why it matters in hiring/assessment, example, related terms (internal links). `DefinedTerm` within a sitewide `DefinedTermSet`. These rank fast (low competition), feed AI-overview citations, and funnel into product pages.

### 5.6 The quality gate (mandatory) — avoid the scaled-content penalty

Before any programmatic page publishes, an **automated validator** must pass it. This is the single most important governance control for this site class. Borrowed directly from the source implementation's content validator and adapted:

1. **Minimum unique word count** (e.g. ≥ 600 for library/role pages, ≥ 1200 for comparison pages) of *page-specific* content — not boilerplate.
2. **Uniqueness check:** the page's distinctive content (intro, topic breakdown, sample questions) must be < X% similar to sibling pages. Reject near-duplicates. (A simple shingling/Jaccard check over the variable blocks catches template-spin.)
3. **Real data present:** the row must have genuine values for the differentiating fields (topics, sample questions, role mapping). No "TBD"/empty-section pages ship.
4. **First-paragraph definitional snippet** 40–60 words.
5. **Mandatory schema** for the page type validates clean.
6. **Internal links:** ≥ N contextual links to hubs/siblings.
7. **FAQ present** with ≥ 6 Q&As where applicable.

Pages that fail are held as drafts, not published. **Roll out the cluster gradually** (e.g. 20–50 high-quality pages/week) and watch GSC indexation + impressions — if Google indexes and ranks them, scale; if it ignores or excludes them, they're too thin. Quality over count, always.

---

## 6. Content & editorial strategy (E-E-A-T)

Technical SEO gets you crawled; content + authority get you ranked. Assessment/hiring content is **trust-sensitive (YMYL-adjacent)** — it influences hiring decisions, fairness, and careers — so **E-E-A-T (Experience, Expertise, Authoritativeness, Trust)** is decisive.

### 6.1 Pillar clusters

Pick 4–6 pillars and build hub-and-spoke clusters:

- **Technical hiring** — how to screen developers, structured interviews, work-sample tests, reducing bias
- **Assessment science** — validity, reliability, adverse-impact, test fairness, proctoring integrity
- **Skill-specific interview/question guides** — "{skill} interview questions", "how to assess {skill}" (links the test-library cluster to editorial)
- **Campus / bulk hiring** and **L&D / skill-gap** (the two ICPs: companies + institutions)
- **Remote & proctored assessment** — integrity, accessibility, accommodations

Each pillar hub links to its supporting posts and the relevant programmatic pages; supporting posts link back to the hub.

### 6.2 Hard quality bar (validator-enforced) for pillar posts

1. **Word count** ≥ 1800 (pillar ≥ 2500) of substantive content.
2. **First-paragraph definitional snippet** (40–60 words).
3. **Structure:** anchor-linked H2 TOC, 8–12 sections.
4. **Internal links** ≥ 15 to your own hubs/library/tools.
5. **External authority citations** ≥ 4 from a curated **trusted-source allowlist** — see 6.3.
6. **Mandatory schema:** `Article` + `FAQPage` + one of (`HowTo`, `DefinedTerm`, `VideoObject`, `ItemList`).
7. **FAQ** 8–15 pairs from PAA.
8. **Comparison table** where the topic is comparative.
9. **`dateModified` refresh** on a cadence (quarterly) so freshness signals stay current.
10. **Author = a real, credentialed person** with a bio page (6.4).

### 6.3 E-E-A-T citation allowlist (the trust differentiator)

Maintain a curated `trusted_sources.json` and enforce ≥ N citations from it per pillar post (use safe **suffix-match** so `fake-shrm.com` doesn't match `shrm.org`). For this domain:

- **Standards & guidelines:** SIOP (Society for Industrial-Organizational Psychology) *Principles*, EEOC *Uniform Guidelines on Employee Selection Procedures*, APA/AERA/NCME *Standards for Educational and Psychological Testing*, ISO 10667 (assessment service delivery), GDPR/data-protection authorities.
- **Research:** peer-reviewed I-O psychology journals, Google Scholar / academic sources on selection validity (e.g. meta-analyses on work-sample test validity).
- **Labor/market data:** BLS, World Economic Forum *Future of Jobs*, LinkedIn Economic Graph, Stack Overflow Developer Survey, GitHub Octoverse.
- **Education side:** accreditation bodies, NCME, institutional research offices.

Citing these is exactly what separates a rankable authority page from generic SEO filler on a trust-sensitive topic.

### 6.4 Author bios, methodology & trust pages

- **`/about` + author pages** with real names, photos, credentials, LinkedIn `sameAs`, and `Person` schema. Google's E-E-A-T leans hard on identifiable expertise for YMYL-adjacent content.
- **A methodology / "how our assessments are validated" page** — describe validity studies, anti-cheat, fairness/bias mitigation, accessibility. This is both a sales asset and an authority signal.
- **`/trust` + `/security`** — SOC 2, ISO 27001, GDPR, data residency. Trust signals matter for B2B SEO and conversion.

### 6.5 Linkable assets (digital PR)

The most durable backlink strategy for this niche:

- **Annual data study** — "State of Technical Hiring / Skills 2026" using your own (anonymized, aggregated) assessment data. Original data earns journalist + blogger links no competitor can replicate. Build it as a dedicated, schema-rich, embeddable page.
- **Free tools** (§ below) and **calculators** (e.g. "cost-of-a-bad-hire calculator") attract links naturally.
- **Glossary + integration pages** earn passive links from partners and educators.

---

## 7. Answer-Engine / Generative-Engine Optimization (GEO/AEO) — net-new for 2026

Search increasingly happens inside **Google AI Overviews / AI Mode, ChatGPT, Perplexity, and Gemini**. Optimizing to be *cited* by these engines is a distinct, now-essential discipline:

1. **Extractable, self-contained answers.** Lead every page/section with a direct, quotable 2–4 sentence answer to the implied question. LLMs lift clean, declarative statements.
2. **Structured data + clean semantics** make content machine-parseable — the same `FAQPage`/`HowTo`/`DefinedTerm`/`Article` schema that earns rich results also helps answer engines extract you.
3. **Question-shaped headings** (`How do you assess a backend developer?`) mirror how users prompt LLMs.
4. **Cite primary sources** (the §6.3 allowlist) — answer engines prefer pages that themselves cite authoritative sources, and being the *citing* hub increases your odds of being the *cited* source.
5. **`llms.txt`** (§3.1) + **don't block beneficial AI crawlers** you want citations from (separate `Disallow: /` for training-only bots from search/answer bots via per-UA rules; use `Content-Signal` where your CDN supports it).
6. **Entity consistency:** consistent brand name, logo, `sameAs`, and a complete `Organization`/`SoftwareApplication` schema build the knowledge-graph entity that both Google and LLMs reason over. Claim/maintain G2, Capterra, Crunchbase, LinkedIn, Wikidata.
7. **Track AI referrals** — monitor referral traffic from `chatgpt.com`, `perplexity.ai`, `gemini.google.com` in analytics; it's a fast-growing channel and a leading indicator of GEO performance.

---

## 8. Off-page & authority

- **Reviews:** drive customers to G2 / Capterra / TrustRadius. Real `AggregateRating` (pulled from those) → star snippets (huge CTR lift) and third-party authority. **Never fabricate reviews or rating schema.**
- **Integration marketplaces:** every ATS/LMS partner page (Greenhouse, Lever, Workday, Moodle, Canvas) is a backlink + referral source. Get listed; link bidirectionally.
- **Digital PR:** pitch the §6.5 data study to HR-tech / ed-tech press and newsletters.
- **Strategic guest content + podcasts** on I-O psychology / talent / ed-tech outlets — earns links *and* author E-E-A-T.
- **Avoid** paid link schemes, PBNs, and "SEO services" selling backlinks — permanent trust damage; disavow takes months.

---

## 9. International SEO (optional module — net-new vs source)

Assessment platforms sell globally; if you localize:

- **`hreflang`** annotations (in `<head>` or the sitemap) for each language/region variant, with a self-referencing entry + `x-default`. Bidirectional and consistent, or Google ignores them.
- **URL strategy:** subdirectories (`/de/`, `/in/`) are simplest to manage and consolidate authority; subdomains/ccTLDs only if you have separate teams/entities.
- **Localize, don't machine-translate-and-dump** — thin auto-translated pages trip the same scaled-content signals as §5.6.
- **Local currency/pricing, local case studies, local compliance** (GDPR for EU, India DPDP, etc.) for relevance + trust.

Skip this entirely if you're single-market — premature `hreflang` is a common foot-gun.

---

## 10. Optional module — public candidate-facing surfaces & the share flywheel

*(Include if candidates get shareable result/score/certificate pages.)*

A public, shareable proof page is a **compounding backlink + branded-traffic flywheel**: every candidate who shares "I scored in the 95th percentile" on LinkedIn / their portfolio / a CV links back to you.

- **Routes:** `/verify/{credential_id}` (public, indexable), `/badge/{id}.svg`, dynamic `/og/verify/{id}.png` for rich link previews.
- **Schema:** `EducationalOccupationalCredential` (name, `credentialCategory`, `recognizedBy` → Organization, `dateCreated`, `about`, `url`) — see §15.
- **Privacy-first (non-negotiable):** these pages are public **only with explicit candidate opt-in**; never expose PII (email, raw answers, employer), only what the candidate chose to share. A `sitemap-verify.xml` lists only `shareable=true` credentials. Robots-disallow any non-shareable result routes.
- **Tamper/revocation UX:** a tampered or revoked credential renders a clear "invalid" state (HTTP 200 with a red badge), **not a 404** — a 404 makes recruiters think the link is broken and kills trust in the share.
- **Distinct OG image per credential** so each share generates a unique, attractive preview.

This is the same mechanic the source platform used for verified-credential pages; it ports cleanly to candidate assessment results.

---

## 11. Measurement & KPIs

**Tools (all free):** GSC, Bing Webmaster Tools, PageSpeed Insights, Rich Results Test, Schema Markup Validator, GA4/Plausible, an AI-referral segment in analytics.

| Metric | Source | Why |
|---|---|---|
| Indexed URLs vs sitemap URLs (per type) | GSC Coverage / Pages | Catches indexation gaps per content class |
| Impressions / clicks / avg position (by cluster) | GSC Performance | Core demand + ranking trend |
| CTR by page (vs position benchmark) | GSC | Title/description optimization targets |
| Rich-result coverage (FAQ, Breadcrumb, Review, Video, App) | GSC Enhancements | Schema health |
| Core Web Vitals (LCP/INP/CLS, mobile field) | GSC CWV / CrUX | Performance ranking factor |
| Referring domains | GSC Links / Ahrefs-free / Search Console | Authority growth |
| AI-engine referral sessions | Analytics | GEO performance (leading indicator) |
| Programmatic-page indexation rate | GSC | Early signal of thin-content rejection |
| Assisted conversions from organic (demo requests / signups) | Analytics | The actual business outcome |

Set 90/180-day targets per metric against the `ASMT-00` baseline.

---

## 12. Ongoing operations cadence

- **On every publish/update** → IndexNow ping (auto) + GSC URL-inspection for top pages.
- **Weekly** → glance at GSC Performance (impressions trend, new queries, sudden drops); scan AI-referral traffic.
- **Monthly** → full GSC review: Coverage errors / excluded / soft-404s (fix each); top queries with CTR < 2% → rewrite titles/descriptions; broken-link + redirect-chain scan; meta-robots audit.
- **Quarterly** → Lighthouse on the top 5 templates; refresh `dateModified` + content on pillar posts; competitive SERP re-check for target clusters; re-audit this playbook; review programmatic-page quality (prune/improve thin performers); update the trusted-source allowlist.
- **Annually** → publish the data study (§6.5); review international/`hreflang` if expanding.

---

## 13. Guardrails — what NOT to do

- **Don't ship a CSR-only marketing site.** Public pages must be server-rendered/static. (The biggest SEO failure mode for assessment SaaS.)
- **Don't mass-produce thin programmatic pages** without the §5.6 quality gate — "scaled content abuse" earns penalties. Quality and uniqueness over count.
- **Don't fabricate Review/AggregateRating** or any schema not matching visible content — manual-action risk.
- **Don't expose candidate PII** in any meta tag, JSON-LD, sitemap, or public page. Opt-in only, minimal data (§10).
- **Don't index the gated app, internal search results, or filter permutations** — index bloat dilutes crawl budget.
- **Don't buy backlinks or hire "SEO services" selling links** — permanent trust damage.
- **Don't keyword-stuff.** Write for humans; schema expresses machine intent.
- **Don't trust your origin `robots.txt`/sitemap** without an external crawler-UA `curl` — the CDN edge may override them.
- **Don't put verification tokens / API keys in the repo** — env vars only.
- **Don't `noindex` a page you could simply fix.**
- **Don't touch any `application/ld+json` block without re-running the Rich Results Test.**

---

## 14. Reusable, sequenced backlog (`ASMT-00 … ASMT-30`)

Ship roughly in priority order; tasks with no dependency can run in parallel.

| ID | Pri | Task |
|---|---|---|
| ASMT-00 | P0 | GSC + Bing connect, sitemap submit, analytics, 7-day baseline |
| ASMT-01 | P0 | `robots.txt` (disallow app/api/og/filters) + `Sitemap:` + external edge verify |
| ASMT-02 | P0 | URL architecture finalized (§1) + canonical host/protocol/trailing-slash redirects |
| ASMT-03 | P0 | Sitemap index + typed child sitemaps + `<lastmod>` + image namespace |
| ASMT-04 | P0 | `<head>` contract component (title/desc/canonical/OG/Twitter) on all public templates |
| ASMT-05 | P0 | SSR/SSG confirmed for all public routes; gated app `noindex`; faceted-filter indexation control |
| ASMT-06 | P0 | Organization + WebSite + SoftwareApplication JSON-LD (home/layout) |
| ASMT-07 | P0 | BreadcrumbList JSON-LD + visible breadcrumbs sitewide |
| ASMT-08 | P0 | Dynamic OG image renderer `/og/{type}/{slug}.png` + cache + slug allowlist |
| ASMT-09 | P0 | IndexNow key + publish-event pings |
| ASMT-10 | P1 | Core Web Vitals pass (LCP/INP/CLS) — fonts, images, code-split, critical CSS if needed |
| ASMT-11 | P1 | FAQPage (visible + schema) on solution / feature / pricing pages |
| ASMT-12 | P1 | Article/BlogPosting + author Person schema + RSS feed on resources |
| ASMT-13 | P1 | **Programmatic: skill-test library** `/tests/{skill}` template + data + §5.6 quality gate |
| ASMT-14 | P1 | **Programmatic: role assessment** `/tests/role/{role}` + ItemList |
| ASMT-15 | P1 | **Programmatic: comparison/alternatives** `/compare/*` + `/alternatives/*` (highest intent) |
| ASMT-16 | P1 | **Programmatic: integrations directory** `/integrations/{partner}` + HowTo |
| ASMT-17 | P1 | **Glossary** `/glossary/{term}` + DefinedTermSet |
| ASMT-18 | P1 | ItemList carousels on library/role/integration/topic hubs |
| ASMT-19 | P1 | Pillar content clusters + 10-point validator + trusted-source allowlist (§6) |
| ASMT-20 | P1 | Author bios + methodology + /trust + /security pages (E-E-A-T) |
| ASMT-21 | P1 | WebSite + SearchAction (requires a working on-site search results page) |
| ASMT-22 | P1 | Free tools `/tools/*` as link magnets (INP-budgeted) |
| ASMT-23 | P2 | VideoObject on demo/tutorial-video pages |
| ASMT-24 | P2 | Review + AggregateRating (gated on real G2/Capterra reviews) |
| ASMT-25 | P2 | Course / certification-prep schema (if offering training) |
| ASMT-26 | P2 | Quiz schema on free practice tests (upside, eligibility-limited) |
| ASMT-27 | P1 | GEO/AEO: `llms.txt`, extractable answers, AI-referral tracking, entity profiles (§7) |
| ASMT-28 | P2 | Brotli/edge compression + WebP/AVIF + asset cache headers |
| ASMT-29 | P2 | International `hreflang` (only if localizing — §9) |
| ASMT-30 | Opt | Public candidate verify/result/badge pages + flywheel (§10) |

---

## 15. Appendix — copy-paste JSON-LD templates

> Replace `{…}`. One `<script type="application/ld+json">` per block. Validate before shipping.

**Organization (sitewide):**
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "{Brand}",
  "url": "https://{domain}/",
  "logo": "https://{domain}/assets/logo.png",
  "sameAs": [
    "https://www.linkedin.com/company/{brand}",
    "https://twitter.com/{brand}",
    "https://www.g2.com/products/{brand}/reviews"
  ],
  "contactPoint": {"@type": "ContactPoint", "contactType": "sales", "email": "sales@{domain}"}
}
```

**SoftwareApplication (home / product):**
```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "{Product}",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "url": "https://{domain}/",
  "description": "{One-sentence value prop for candidate/team assessment}",
  "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD", "category": "Free trial"},
  "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.7", "ratingCount": "312"}
}
```
*(Include `aggregateRating` ONLY with real, verifiable review data.)*

**Service (solution page):**
```json
{
  "@context": "https://schema.org",
  "@type": "Service",
  "serviceType": "Pre-employment skills assessment",
  "provider": {"@type": "Organization", "name": "{Brand}"},
  "areaServed": "Worldwide",
  "description": "{What this solution does for IT hiring / institutions}",
  "url": "https://{domain}/solutions/it-hiring"
}
```

**BreadcrumbList (deep pages — current page has no `item`):**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://{domain}/"},
    {"@type": "ListItem", "position": 2, "name": "Tests", "item": "https://{domain}/tests"},
    {"@type": "ListItem", "position": 3, "name": "Python Test"}
  ]
}
```

**FAQPage (mirror a visible FAQ section):**
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {"@type": "Question", "name": "How long is a Python assessment?",
     "acceptedAnswer": {"@type": "Answer", "text": "Most Python screening tests run 30–60 minutes…"}}
  ]
}
```

**Article / BlogPosting (resource post):**
```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "{Post title ≤ 110 chars}",
  "datePublished": "{ISO-8601}",
  "dateModified": "{ISO-8601}",
  "author": {"@type": "Person", "name": "{Real author}", "url": "https://{domain}/authors/{slug}"},
  "publisher": {"@type": "Organization", "name": "{Brand}",
                "logo": {"@type": "ImageObject", "url": "https://{domain}/assets/logo.png"}},
  "image": "https://{domain}/og/resource/{slug}.png",
  "mainEntityOfPage": "https://{domain}/resources/{slug}",
  "description": "{meta description}"
}
```

**ItemList (library/role/integration hub):**
```json
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Developer skill tests",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "url": "https://{domain}/tests/python", "name": "Python Test"},
    {"@type": "ListItem", "position": 2, "url": "https://{domain}/tests/sql", "name": "SQL Test"}
  ]
}
```

**DefinedTerm (glossary):**
```json
{
  "@context": "https://schema.org",
  "@type": "DefinedTerm",
  "name": "Adverse Impact",
  "description": "A substantially different selection rate that disadvantages a protected group…",
  "inDefinedTermSet": {"@type": "DefinedTermSet", "name": "{Brand} Assessment Glossary",
                        "url": "https://{domain}/glossary"},
  "url": "https://{domain}/glossary/adverse-impact"
}
```

**HowTo (integration setup / guide):**
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to connect {Brand} to Greenhouse",
  "step": [
    {"@type": "HowToStep", "position": 1, "name": "Open the integrations panel",
     "text": "In Settings → Integrations, select Greenhouse.",
     "url": "https://{domain}/integrations/greenhouse#step1"}
  ]
}
```

**VideoObject (demo/tutorial pages):**
```json
{
  "@context": "https://schema.org",
  "@type": "VideoObject",
  "name": "{Video title}",
  "description": "{Description}",
  "thumbnailUrl": "https://i.ytimg.com/vi/{id}/maxresdefault.jpg",
  "uploadDate": "{ISO-8601}",
  "duration": "PT3M42S",
  "contentUrl": "https://www.youtube.com/watch?v={id}",
  "embedUrl": "https://www.youtube.com/embed/{id}"
}
```

**EducationalOccupationalCredential (optional §10 verify page):**
```json
{
  "@context": "https://schema.org",
  "@type": "EducationalOccupationalCredential",
  "name": "{Skill} Proficiency — {Level}",
  "credentialCategory": "certificate",
  "recognizedBy": {"@type": "Organization", "name": "{Brand}"},
  "dateCreated": "{ISO-8601}",
  "about": {"@type": "Thing", "name": "{Skill}"},
  "url": "https://{domain}/verify/{credential_id}"
}
```

---

### Provenance note

This playbook is methodology only — extracted from a shipped, measured 27-task SEO implementation (technical foundation, full JSON-LD stack, typed sitemaps, dynamic OG images, IndexNow, programmatic page clusters with a validator-enforced quality bar, E-E-A-T citation governance, and a public-credential share flywheel) and re-mapped to the candidate-assessment domain. **Net-new additions** beyond the source plan: §3.4 rendering decision-tree, §3.1 `llms.txt` + edge-verify discipline, §4 INP (2024 Core Web Vital), §5.6 scaled-content-abuse quality governance, §7 GEO/AEO, §8 review/integration authority loops, §9 international/`hreflang`, and §3.3 faceted-filter indexation management — all standard best practice for a 2026 B2B SaaS catalog site.

---

## 16. AssessIQ reality addendum (project-specific deltas)

> **Appended 2026-05-22 after reviewing this playbook against the live AssessIQ codebase.** §0–§15 above are a stack-agnostic ideal. This section reconciles them with what AssessIQ *actually is today*. **Where §16 conflicts with §0–§15 for AssessIQ specifically, §16 wins.** Verified facts cited inline.

### 16.1 The governing fact — current stack & public surface

| What the playbook assumes | What AssessIQ actually is | Source |
|---|---|---|
| SSR/SSG framework (Next/Nuxt/Astro) | **Vite + React 18 + react-router-dom — pure client-side SPA** | `apps/web/package.json` |
| An existing public site to optimize | **Zero public pages.** `/` does `<Navigate to="/admin/login">` | `apps/web/src/App.tsx:73` |
| Marketing/library/blog routes exist | **Every route is gated app surface** (`/admin/*`, `/candidate/*`, `/take/*`, `/admin/invite/accept`) — exactly the §1 "noindex" set | `apps/web/src/App.tsx` |
| nginx edge (§3.9) | **Caddy behind Cloudflare**, Authenticated Origin Pulls + `x-origin-verify` in `enforce` mode | `docs/06-deployment.md`, RCA 2026-05-22 |

**Consequence:** for AssessIQ this is **greenfield public-site *construction*, not optimization.** Googlebot hitting `assessiq.in/` today is redirected into a login wall and indexes nothing. Re-read the entire plan through that lens — most P0 tasks presuppose pages that do not exist yet.

### 16.2 The decision that gates everything — resolve §3.4 FIRST (new `ASMT-00.5`, P0 blocker)

§3.4 files the CSR-only case under "decision-tree *if the stack ever changes*" and calls it *"the highest-risk posture."* **For AssessIQ that posture is reality, not a hypothetical** — so it must be decided before any other SEO task. A client-side-rendered blog or marketing page will **not** rank; this is non-negotiable, not a tuning detail. Two viable paths:

- **(Recommended) A separate SSR/SSG marketing site** — Astro (lightest for content) or Next — served on `assessiq.in` (apex/`www`), **decoupled from the app SPA.** Rationale: marketing content lifecycle ≠ app release cadence; keeps the React app bundle lean; lets About/Blog/Contact be statically rendered and therefore actually indexable; isolates SEO experiments from the load-bearing app.
- **Prerender the existing SPA** (`vite-plugin-ssg` / a prerender step at build). Cheaper short-term, but couples marketing to app deploys and the SPA was not architected for it. Acceptable *only* if the public surface stays tiny and fully static.

Pick this before writing a single public page. Everything in §1–§15 depends on the answer.

### 16.3 Minimum viable public surface (per the About / Blog / Contact intent)

Start with the smallest set that earns real SEO value, **not** the full §5 programmatic engine. Build the §5 clusters (`/tests/*`, `/compare/*`, `/glossary/*`, `/integrations/*`) only after the MVP surface proves the render→index→rank pipeline works. *Don't build 500 pages before 5 rank.*

| Page | SEO value | Effort | Verdict |
|---|---|---|---|
| **Home `/`** (replace the `/admin/login` redirect with a real, indexable landing for unauthenticated visitors; authed users still route to the app) | **Highest** — the entity anchor. Carries `Organization` + `WebSite` + `SoftwareApplication` schema | Med | **Do first** |
| **`/about`** | High — core **E-E-A-T / trust** signal (who is behind a YMYL-adjacent hiring product). Real names, `Organization`/`Person` schema | Low | **Do** |
| **`/contact`** | Low-direct, but a legitimacy/NAP signal; feeds `Organization.contactPoint` | Low | **Do** |
| **`/blog` (or `/resources`)** | High — the actual ranking engine (§6) | **High & ongoing** | **Only if you sustain a content cadence.** An abandoned 3-post blog hurts more than no blog. MUST be SSG/SSR (§16.2) |
| **Header / footer nav** | Site-wide internal links to money pages (§3.8) | Low | **Do** — footer carries Home/About/Blog/Contact (and Pricing later) on every public page |

### 16.4 Edge & deploy deltas (your §3.9 is nginx; you run Caddy + Cloudflare)

- **`x-origin-verify` is in `enforce` mode.** Any new public route must reach the origin **through Cloudflare** so the injected `x-origin-verify` header is present — a direct-origin hit or a mis-scoped Cloudflare rule returns **429 / TLS-rejects**. You have already lived this exact failure (RCA 2026-05-22: the Cloudflare Transform Rule request-vs-response bug that 429'd `assessiq.in`). When public marketing routes go live, confirm Googlebot's path through CF injects the header.
- **§3.1's "don't trust your origin `robots.txt` — `curl` with a crawler UA" is proven for you, not theoretical.** Re-verify `robots.txt`, the sitemap, and every public page with a real Googlebot UA *through the edge* before trusting origin config.
- **Shared VPS, additive-only (CLAUDE.md rule #8).** A new public site/routes = an **additive** Caddy block under the `assessiq` namespace. Enumerate before touching; never blanket-reload or alter other tenants' config.

### 16.5 Canonical host is brand-new — baseline from near-zero

- `assessiq.in` became canonical **2026-05-22**; `automateedge.cloud` now `301`s to it (this already satisfies the §3.3 one-host rule — good). `ASMT-00` must verify **`assessiq.in`** (DNS TXT) in GSC/Bing.
- Treat index history as **effectively zero** — set 90/180-day targets against a fresh baseline, not legacy-host data.
- You have both apex and `www` Caddy blocks: pick **one** canonical and `301` the other.

### 16.6 §10 public candidate pages = LOAD-BEARING security gate, not an "optional module"

AssessIQ has a **documented candidate answer-key / PII leak history** (RCA 2026-05-16/05-22; memory `ui-question-payload-raw-json`). Therefore any public `/verify`, `/result`, or `/badge` page is **tenancy- and grading-adjacent load-bearing code** and **must pass the `codex:rescue` adversarial gate before push** (CLAUDE.md load-bearing rule). Opt-in only; minimal data; **never** expose PII (email, raw answers, employer) in any meta tag, JSON-LD, or sitemap. Re-frame §10 from "nice flywheel" to "high-risk, gated — defer until the core surface is stable."

### 16.7 Backlog re-sequencing for AssessIQ

- **`ASMT-00.5` (NEW, P0, hard blocker):** resolve the rendering architecture (§16.2 / §3.4). Blocks all of §1–§15.
- **`ASMT-00b` (NEW, P0):** replace the `/`→`/admin/login` redirect with a real indexable home; serve the app only to authenticated users.
- **Then** the §16.3 MVP surface (home / about / contact, + blog only with a committed cadence) — **before** any §5 programmatic cluster.
- **`ASMT-29` (international `hreflang`): skip** — single-market today; premature `hreflang` is a foot-gun (§9 already warns this).
- Add an **effort + "this-quarter / later"** annotation to each `ASMT-*` row — with a from-scratch site, P0/P1/P2 alone doesn't tell you what's affordable now.

### 16.8 What's genuinely missing from §0–§15 (stack-independent)

- **Status-code / soft-404 discipline** for the new public routes (a CSR `*`→`<NotFound>` that returns HTTP 200 is a soft-404; the marketing site must return real 404s).
- **No ownership/RACI** — fine for a methodology doc, but assign one before execution.
- **A11y as a ranking + compliance lever** — you already have `@axe-core/playwright` and `@lhci/cli` wired in `apps/web`; reuse them to gate the public site's CWV/a11y in CI rather than standing up new tooling.

---

## 17. AssessIQ chosen strategy (the locked plan)

> **Decided 2026-05-22.** §0–§15 are the generic ideal; §16 is the reality check; **§17 is what we are actually building, in order.** Where §17 conflicts with §0–§16, §17 wins. Inputs that shaped this (confirmed with the product owner):
>
> - **GTM:** hybrid — sell to companies/institutions (the *buyer*) **and** want candidate-facing volume.
> - **Market:** India-first, global later.
> - **Content bandwidth:** occasional (~monthly) — no content treadmill.
> - **Domain:** `assessiq.in`, canonical since 2026-05-22, **near-zero authority** (new domain).

### 17.1 The thesis

**Win the queries a zero-authority new domain *can* win — branded, India-specific, and high-intent comparison searches — with a small set of excellent evergreen pages, and let the hybrid model's free asset (candidate result-sharing) build links.** Do **not** fight global head terms (`coding assessment platform`) or mass-produce thin programmatic pages we can't maintain.

SEO is a **support channel** here, not the primary pipe for a sales-led-ish B2B product. **Realistic horizon: 6–12 months to meaningful organic traffic.** Set expectations accordingly; front-load cheap, permanent assets over a content treadmill.

### 17.2 The four phases (execution order)

**Phase 0 — the gate (before anything):** Lock rendering (§16.2). **Decision: Astro SSG as a separate marketing site**, decoupled from the React SPA — chosen because the public surface is mostly static + content is lean (build-once, fastest, cheapest to maintain; SSR's per-request value isn't needed). This unblocks everything below.

**Phase 1 — Foundation & entity (Month 1–2, mostly build-once):**
- Real indexable **home** (retire the `/`→`/admin/login` redirect for logged-out visitors; authed users still route to the app), **About**, **Contact**, **Pricing**, **`/trust` + `/security`** (India DPDP, data residency — institutions and buyers care).
- 3–4 **solution pages** for the India ICPs: IT/tech hiring, campus recruitment, educational institutions (proctored exams), team skill-gap.
- Technical base: `Organization`/`WebSite`/`SoftwareApplication` schema, typed sitemaps, `robots.txt`, canonicals, **GSC + Bing baseline on `assessiq.in`**.
- **GEO/AEO from day one** (cheap): `llms.txt`, extractable lead answers, and claim the entity on **G2, Capterra, Crunchbase, LinkedIn**.

**Phase 2 — High-intent commercial pages (Month 2–3, best ROI):**
- A **small hand-crafted set (~8–15) of comparison/alternative pages** vs. who Indian buyers actually evaluate: **Mercer Mettl, HackerEarth, iMocha, HackerRank**; for campus, **AMCAT / CoCubes**. e.g. *"Mercer Mettl alternative for Indian companies."* Highest-converting B2B asset, wins on long-tail despite low authority, annual refresh only.

**Phase 3 — Evergreen long-tail engine, quality-gated (Month 3–6):**
- **Glossary** (psychometrics + India hiring terms) — ranks fast, near-zero competition, low maintenance, feeds AI citations.
- A **modest test-library cluster — start with ~20–40 skills**, not 500 — focused on Indian volume-hiring skills (Python, Java, SQL, .NET, React, aptitude, logical reasoning, English). Every page passes the **§5.6 quality gate**. Serves both sides of the hybrid model. Roll out gradually; scale only what indexes + ranks.

**Phase 4 — Authority within bandwidth (ongoing ~monthly):**
- **ONE content pillar**, not a sprawling blog: *"Technical & campus hiring in India"* (structured interviews, reducing bias, remote-proctoring integrity, campus placement assessment). Real author, E-E-A-T, ~monthly cadence.
- **Candidate share flywheel** (§10) **if** shareable certificates/scorecards are offered — build once, compounds free. **Load-bearing + PII-sensitive → `codex:rescue` gate before ship** (per §16.6 and the answer-key/PII leak history).
- **Annual "State of Tech Hiring in India" data study** — the one big link-magnet per year.

### 17.3 Deliberately NOT doing (given constraints)

- ❌ Full 500-page programmatic engine — unmaintainable + scaled-content-penalty risk.
- ❌ Global head-term competition — deferred to the "global later" phase.
- ❌ High-frequency blog — bandwidth is monthly; don't pretend otherwise.
- ❌ `hreflang` / international (§9, `ASMT-29`) — single-market for now.
- ❌ Fabricated reviews / paid links — permanent trust damage.

### 17.4 The 80/20

If only **three** things ship: **(1)** Astro SSG foundation + entity (Phase 1), **(2)** India comparison/alternative pages (Phase 2), **(3)** glossary + GEO basics (Phase 3 start). That captures most of the winnable outcome for a fraction of the 31-task effort.

### 17.5 Re-cut backlog — generic `ASMT-*` mapped to AssessIQ phases

Original §14 IDs preserved for traceability; resequenced and pruned for this plan.

| Phase | Task (orig. ID) | Notes |
|---|---|---|
| **0** | `ASMT-00.5` Lock rendering = **Astro SSG separate site** | Hard blocker for all below |
| **1** | `ASMT-00` GSC/Bing baseline on `assessiq.in` | From near-zero |
| **1** | `ASMT-00b` Real indexable home (retire login redirect) | NEW |
| **1** | `ASMT-01` robots.txt + Sitemap + edge `curl`-verify | Caddy/Cloudflare caveat (§16.4) |
| **1** | `ASMT-02` URL architecture + canonical host/trailing-slash | apex vs www: pick one, 301 other |
| **1** | `ASMT-03` Typed sitemaps + `<lastmod>` + image ns | |
| **1** | `ASMT-04` `<head>` contract component | |
| **1** | `ASMT-06` Organization + WebSite + SoftwareApplication JSON-LD | Entity anchor |
| **1** | `ASMT-07` BreadcrumbList + visible breadcrumbs | |
| **1** | Solution pages (IT / campus / institutions / skill-gap) + `ASMT-11` FAQPage | India ICPs |
| **1** | `/trust` + `/security` (subset of `ASMT-20`) | India DPDP / data residency |
| **1** | `ASMT-27` GEO/AEO: llms.txt, extractable answers, entity profiles | Cheap, front-loaded |
| **1** | `ASMT-08` Dynamic OG images | Lighter priority if Astro static OG is simpler |
| **1** | `ASMT-09` IndexNow | |
| **2** | `ASMT-15` **Comparison / alternatives** (Mettl, HackerEarth, iMocha, HackerRank, AMCAT/CoCubes) | **Best ROI** |
| **3** | `ASMT-17` Glossary + DefinedTermSet | Fast wins |
| **3** | `ASMT-13` Skill-test library (~20–40 skills) + §5.6 gate | Modest, not 500 |
| **3** | `ASMT-18` ItemList carousels on hubs | |
| **3** | `ASMT-10` Core Web Vitals pass | Astro makes this mostly free |
| **3** | `ASMT-22` Free tools (lead magnets) | Candidate-side of hybrid |
| **4** | `ASMT-19` ONE pillar cluster + validator + trusted-source allowlist | ~monthly, not weekly |
| **4** | `ASMT-12` Article/BlogPosting + author Person schema + RSS | |
| **4** | `ASMT-20` Author bios + methodology (rest) | E-E-A-T |
| **4** | `ASMT-30` Candidate verify/share flywheel | **codex:rescue gate** (PII) |
| **4** | `ASMT-24` Review + AggregateRating | Only with real G2/Capterra reviews |
| **Defer** | `ASMT-14` role pages, `ASMT-16` integrations, `ASMT-21` SearchAction | After core surface proves out |
| **Defer** | `ASMT-23` VideoObject, `ASMT-25` Course, `ASMT-26` Quiz, `ASMT-28` compression | Opportunistic upside |
| **Skip** | `ASMT-29` international/`hreflang` | Single-market until "global later" |

### 17.6 Success signals (decide whether to scale Phase 3)

After Phase 1–2 are live ~8 weeks: if GSC shows the foundation + comparison pages getting **indexed and accumulating impressions on India queries**, scale the Phase 3 library. If they sit unindexed/excluded, the pages are too thin or rendering is wrong — fix before scaling, per §5.6's "if Google ignores them, they're too thin."
